// AA 客户端：各种失败形态都必须是「无法判断」，并且只对网络错误、超时、5xx 重试（API.md 第 3、6 节）。

import { afterEach, describe, expect, it } from 'vitest'
import { AaClient } from '../src/aa'
import { Env, GROUP, KEY_ID, SECRET, setup } from './harness'

let env: Env
afterEach(async () => {
  await env?.stop()
})

function client(options: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}) {
  return new AaClient(env.app, {
    baseUrl: options.baseUrl ?? env.aa.baseUrl,
    keyId: KEY_ID,
    secret: options.secret ?? SECRET,
    timeoutMs: options.timeoutMs ?? 2000,
  })
}

describe('AA 客户端：成功', () => {
  it('签名被 AA 接受，health / groups 能解析', async () => {
    env = await setup()
    const aa = client()
    const health = await aa.health()
    expect(health.ok).toBe(true)
    const groups = await aa.groups()
    expect(groups.ok && groups.groups).toEqual([{ groupId: GROUP, name: '联盟聊天群', kind: 'fixed' }])
    expect(aa.clockSkewMs).not.toBeNull()
  })

  it('请求头和请求体符合 API.md 2.1', async () => {
    env = await setup()
    await client().check(GROUP, ['40001'], false)
    const request = env.aa.last('check')!
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['x-qqbot-key']).toBe(KEY_ID)
    expect(request.headers['x-qqbot-timestamp']).toMatch(/^\d{10}$/) // 秒，不是毫秒
    expect(request.headers['x-qqbot-nonce']).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(request.body).toEqual({ group_id: GROUP, qqs: ['40001'], full_roster: false })
  })

  it('AA 装在子路径下时，签名用带前缀的路径', async () => {
    env = await setup()
    const result = await client({ baseUrl: `${env.aa.baseUrl}/auth/` }).health()
    expect(result.ok).toBe(true)
  })

  it('密钥不对：401 bad_signature，不重试，给出中文提示', async () => {
    env = await setup()
    const result = await client({ secret: 'wrong-secret-wrong-secret-wrong-secret' }).health({ retryDelays: [10, 10] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
    expect(result.error).toBe('bad_signature')
    expect(result.hint).toContain('密钥')
    expect(env.aa.count('health')).toBe(1)
  })
})

describe('AA 客户端：失败一律是「无法判断」', () => {
  it('302 跳到登录页（APPS_WITH_PUBLIC_VIEWS 没配）：不跟随、不重试，提示怎么修', async () => {
    env = await setup()
    env.aa.override('check', { status: 302, body: '', headers: { Location: '/account/login/?next=/qqbot/api/v1/check/' } })
    const result = await client().check(GROUP, ['40001'], false, { retryDelays: [10, 10] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(302)
    expect(result.retryable).toBe(false)
    expect(result.hint).toContain('APPS_WITH_PUBLIC_VIEWS')
    expect(env.aa.count('check')).toBe(1)
  })

  it('200 但是网页：无法判断，不重试', async () => {
    env = await setup()
    env.aa.override('check', { status: 200, body: '<html><body>登录</body></html>', headers: { 'Content-Type': 'text/html' } })
    const result = await client().check(GROUP, ['40001'], false, { retryDelays: [10] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('invalid')
    expect(env.aa.count('check')).toBe(1)
  })

  it('200 JSON 但 ok 不是 true：无法判断', async () => {
    env = await setup()
    env.aa.override('check', { status: 200, body: '{"ok":"yes","results":[]}', headers: { 'Content-Type': 'application/json' } })
    const result = await client().check(GROUP, [], false)
    expect(result.ok).toBe(false)
  })

  it('500：重试，每次都重新签名（随机数不同）', async () => {
    env = await setup()
    env.aa.override('health', { status: 500, body: '{"ok":false,"error":"internal_error"}' }, 2)
    const result = await client().health({ retryDelays: [10, 10] })
    expect(result.ok).toBe(true)
    const nonces = env.aa.requests.filter((r) => r.name === 'health').map((r) => r.headers['x-qqbot-nonce'])
    expect(nonces).toHaveLength(3)
    expect(new Set(nonces).size).toBe(3)
  })

  it('503 misconfigured：不重试', async () => {
    env = await setup()
    env.aa.override('health', { status: 503, body: '{"ok":false,"error":"misconfigured","message":"没有配置密钥"}' })
    const result = await client().health({ retryDelays: [10, 10] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hint).toContain('QQBOT_API_KEYS')
    expect(env.aa.count('health')).toBe(1)
  })

  it('网关 502 网页：重试后仍失败 → 无法判断', async () => {
    env = await setup()
    env.aa.override('health', { status: 502, body: '<html>Bad Gateway</html>', headers: { 'Content-Type': 'text/html' } })
    const result = await client().health({ retryDelays: [10] })
    expect(result.ok).toBe(false)
    expect(env.aa.count('health')).toBe(2)
  })

  it('连接被断开：网络错误，重试', async () => {
    env = await setup()
    env.aa.override('health', { status: 0, body: '', destroy: true })
    const result = await client().health({ retryDelays: [10] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('network')
    expect(env.aa.count('health')).toBe(2)
  })

  it('超时：无法判断', async () => {
    env = await setup()
    env.aa.override('health', { status: 200, body: '{"ok":true}', delayMs: 1500 })
    const result = await client({ timeoutMs: 300 }).health({ retryDelays: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
  })

  it('429：按 Retry-After 等待后重试', async () => {
    env = await setup()
    env.aa.override('health', { status: 429, body: '{"ok":false,"error":"rate_limited"}', headers: { 'Retry-After': '1' } }, 1)
    const started = Date.now()
    const result = await client().health({ retryDelays: [10] })
    expect(result.ok).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('中止信号：立即结束', async () => {
    env = await setup()
    env.aa.override('health', { status: 200, body: '{"ok":true}', delayMs: 1500 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await client().health({ signal: controller.signal })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('aborted')
  })

  it('AA 网址不是 http(s)：直接失败', async () => {
    env = await setup()
    const result = await client({ baseUrl: 'ftp://example.com' }).health()
    expect(result.ok).toBe(false)
  })
})

describe('AA 客户端：check 结果的结构校验', () => {
  const ok = (results: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, server_time: new Date().toISOString(), group_id: GROUP, results, roster: null }) })

  it('结果数量对不上：整个请求无法判断', async () => {
    env = await setup()
    env.aa.override('check', ok([{ qq: '40001', decision: 'deny', reason: 'NOT_BOUND', card: null }]))
    const result = await client().check(GROUP, ['40001', '40002'], false)
    expect(result.ok).toBe(false)
  })

  it('回显的 QQ 和请求的不一致：这一项当作无法判断', async () => {
    env = await setup()
    env.aa.override('check', ok([{ qq: '49999', decision: 'deny', reason: 'NOT_BOUND', card: null }]))
    const result = await client().check(GROUP, ['40001'], false)
    expect(result.ok && result.verdicts.get('40001')?.decision).toBe('unknown')
  })

  it('不认识的 decision：当作无法判断', async () => {
    env = await setup()
    env.aa.override('check', ok([{ qq: '40001', decision: 'kick', reason: 'X', card: null }]))
    const result = await client().check(GROUP, ['40001'], false)
    expect(result.ok && result.verdicts.get('40001')?.decision).toBe('unknown')
  })

  it('不认识的 reason：按 decision 处理', async () => {
    env = await setup()
    env.aa.override('check', ok([{ qq: '40001', decision: 'deny', reason: 'SOMETHING_NEW', card: null }]))
    const result = await client().check(GROUP, ['40001'], false)
    expect(result.ok && result.verdicts.get('40001')).toEqual({ qq: '40001', decision: 'deny', reason: 'SOMETHING_NEW', card: null })
  })

  it('deny 时即使带了 card 也忽略', async () => {
    env = await setup()
    env.aa.override('check', ok([{ qq: '40001', decision: 'deny', reason: 'NOT_BOUND', card: 'x' }]))
    const result = await client().check(GROUP, ['40001'], false)
    expect(result.ok && result.verdicts.get('40001')?.card).toBeNull()
  })
})
