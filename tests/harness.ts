// 集成测试用的模拟环境：真实的 Koishi 4.18 + adapter-onebot 6.9.4 + 内存数据库，
// 外加一个模拟的 AA 服务器（按 API.md 校验签名）和一个模拟的 OneBot 实现（代替 LLBot）。

import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from 'koishi'
import HTTP from '@koishijs/plugin-http'
import Memory from '@koishijs/plugin-database-memory'
import { OneBot, OneBotBot } from 'koishi-plugin-adapter-onebot'
import { registerCommands } from '../src/commands'
import type { Config } from '../src/config'
import { Guard } from '../src/guard'

export const KEY_ID = 'koishi-test'
export const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
export const BOT = '12345'
export const GROUP = '111111111'
export const OTHER_GROUP = '222222222'
export const ADMIN_GROUP = '333333333'
export const OPERATOR = '55555'
export const OWNER = '10001'
export const ADMIN = '10002'

// ------------------------------------------------------------------ 模拟 AA

interface FakeVerdict {
  decision: string
  reason: string
  card: string | null
}

interface Override {
  status: number
  body: string
  headers?: Record<string, string>
  destroy?: boolean
  delayMs?: number
}

export class FakeAA {
  server!: http.Server
  baseUrl = ''
  requests: Array<{ name: string; body: any; headers: http.IncomingHttpHeaders }> = []
  groups: Array<{ group_id: string; name: string; kind: string }> = [{ group_id: GROUP, name: '联盟聊天群', kind: 'fixed' }]
  /** QQ → 判定（所有群相同，除非 groupVerdicts 里单独设了）。没设的 QQ 为 NOT_BOUND。 */
  verdicts = new Map<string, FakeVerdict>()
  groupVerdicts = new Map<string, FakeVerdict>()
  /** 验证码 → QQ。 */
  codes = new Map<string, string>()
  events: Array<{ id: number; kind: string; qq: string }> = []
  /** 接口名 → 下一次（或每次）返回的固定响应。 */
  overrides = new Map<string, Override & { times?: number }>()
  private nonces = new Set<string>()

  allow(qq: string, card: string) {
    this.verdicts.set(qq, { decision: 'allow', reason: 'OK', card })
  }

  deny(qq: string, reason = 'NOT_BOUND') {
    this.verdicts.set(qq, { decision: 'deny', reason, card: null })
  }

  review(qq: string, reason = 'CONFLICT') {
    this.verdicts.set(qq, { decision: 'review', reason, card: null })
  }

  override(name: string, response: Override, times = Infinity) {
    this.overrides.set(name, { ...response, times })
  }

  count(name: string) {
    return this.requests.filter((r) => r.name === name).length
  }

  last(name: string) {
    return [...this.requests].reverse().find((r) => r.name === name)
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => void this.handle(req, res, Buffer.concat(chunks).toString('utf8')))
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private verdict(groupId: string, qq: string): FakeVerdict {
    return this.groupVerdicts.get(`${groupId}:${qq}`) ?? this.verdicts.get(qq) ?? { decision: 'deny', reason: 'NOT_BOUND', card: null }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }
    const match = /\/qqbot\/api\/v1\/(\w+)\/$/.exec(req.url ?? '')
    const name = match?.[1] ?? '?'
    let body: any = null
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {}
    this.requests.push({ name, body, headers: req.headers })

    const override = this.overrides.get(name)
    if (override) {
      if (--override.times! <= 0) this.overrides.delete(name)
      if (override.delayMs) await new Promise((r) => setTimeout(r, override.delayMs))
      if (override.destroy) return req.socket.destroy()
      res.statusCode = override.status
      for (const [k, v] of Object.entries(override.headers ?? {})) res.setHeader(k, v)
      return res.end(override.body)
    }

    // 按 API.md 2.3 的顺序校验
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method_not_allowed' })
    const key = req.headers['x-qqbot-key']
    const ts = req.headers['x-qqbot-timestamp']
    const nonce = req.headers['x-qqbot-nonce']
    const signature = req.headers['x-qqbot-signature']
    if (typeof key !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string'
      || !/^\d{1,16}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)
      || req.headers['content-type'] !== 'application/json') {
      return send(401, { ok: false, error: 'missing_headers' })
    }
    if (key !== KEY_ID) return send(401, { ok: false, error: 'unknown_key' })
    if (Math.abs(Number(ts) - Date.now() / 1000) > 300) return send(401, { ok: false, error: 'stale_timestamp' })
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex')
    const expected = createHmac('sha256', SECRET).update(['POST', req.url, ts, nonce, hash].join('\n'), 'utf8').digest('hex')
    if (expected !== signature) return send(401, { ok: false, error: 'bad_signature' })
    if (this.nonces.has(nonce)) return send(401, { ok: false, error: 'replayed_nonce' })
    this.nonces.add(nonce)

    const server_time = new Date().toISOString()
    switch (name) {
      case 'health':
        return send(200, { ok: true, server_time, version: '1.0.0', config_ok: true, problems: [] })
      case 'groups':
        return send(200, { ok: true, server_time, groups: this.groups })
      case 'check': {
        if (!this.groups.some((g) => g.group_id === String(body.group_id))) return send(404, { ok: false, error: 'unknown_group', message: '群不存在' })
        const results = body.qqs.map((qq: string) => ({ qq, ...this.verdict(String(body.group_id), qq) }))
        return send(200, { ok: true, server_time, group_id: String(body.group_id), results, roster: body.full_roster ? { added: 0, removed: 0, total: body.qqs.length } : null })
      }
      case 'claim': {
        const groupId = String(body.group_id)
        if (!this.groups.some((g) => g.group_id === groupId)) return send(404, { ok: false, error: 'unknown_group' })
        const found = /QQ-?([A-Z0-9]{6})/i.exec(body.text ?? '')
        let outcome = 'no_code'
        let claimed = false
        if (found) {
          const code = found[1].toUpperCase()
          const owner = this.codes.get(code)
          if (!owner) outcome = 'code_invalid'
          else if (owner !== body.qq) outcome = 'qq_mismatch'
          else {
            outcome = 'claimed'
            claimed = true
            this.codes.delete(code)
            if (this.verdict(groupId, body.qq).decision !== 'allow') this.allow(body.qq, `[IGC] 新人${body.qq}`)
          }
        }
        return send(200, { ok: true, server_time, claimed, outcome, message: '', result: { qq: body.qq, ...this.verdict(groupId, body.qq) } })
      }
      case 'events': {
        const after = body.after
        const limit = body.limit ?? 200
        const newer = this.events.filter((e) => e.id > after)
        const page = newer.slice(0, limit)
        const last_id = page.length ? page[page.length - 1].id : after
        return send(200, { ok: true, server_time, events: page.map((e) => ({ ...e, created_at: server_time })), last_id, has_more: newer.length > page.length })
      }
    }
    return send(404, { ok: false, error: 'not_found' })
  }
}

// ------------------------------------------------------------------ 模拟 QQ（OneBot / LLBot）

export interface FakeMember {
  user_id: number
  role: 'owner' | 'admin' | 'member'
  card: string
  nickname: string
  is_robot?: boolean
}

export interface SentMessage {
  kind: 'group' | 'private'
  target: string
  /** 纯文本（@ 显示为 `@QQ`）。 */
  text: string
  /** 被 @ 的 QQ。 */
  ats: string[]
  raw: unknown
}

export class FakeQQ {
  groups = new Map<string, Map<string, FakeMember>>()
  calls: Array<{ action: string; params: any }> = []
  sent: SentMessage[] = []
  requests: Array<{ flag: string; approve: boolean; reason: string }> = []
  failKick = new Set<string>()
  failSend = false
  systemMsg: any = { join_requests: [], invited_requests: [] }
  private messageId = 0

  addGroup(groupId: string, members: FakeMember[]) {
    this.groups.set(groupId, new Map(members.map((m) => [String(m.user_id), { ...m }])))
  }

  member(groupId: string, qq: string) {
    return this.groups.get(groupId)?.get(qq)
  }

  actions(name: string) {
    return this.calls.filter((c) => c.action === name)
  }

  groupMessages(groupId: string) {
    return this.sent.filter((m) => m.kind === 'group' && m.target === groupId)
  }

  handle(action: string, params: any): { retcode: number; data: any; status?: string } {
    this.calls.push({ action, params: JSON.parse(JSON.stringify(params ?? {})) })
    const ok = (data: any = null) => ({ status: 'ok', retcode: 0, data })
    const fail = (retcode = 1200) => ({ status: 'failed', retcode, data: null })
    const group = this.groups.get(String(params?.group_id))
    switch (action) {
      case 'get_login_info':
        return ok({ user_id: +BOT, nickname: 'bot' })
      case 'get_group_member_list':
        if (!group) return fail(100)
        return ok([...group.values()].map((m) => ({ group_id: params.group_id, ...m })))
      case 'get_group_member_info': {
        const m = group?.get(String(params.user_id))
        return m ? ok({ group_id: params.group_id, ...m }) : fail(100)
      }
      case 'set_group_kick': {
        if (this.failKick.has(String(params.user_id)) || !group?.has(String(params.user_id))) return fail(1200)
        group.delete(String(params.user_id))
        return ok()
      }
      case 'set_group_card': {
        const m = group?.get(String(params.user_id))
        if (!m) return fail(1200)
        m.card = params.card
        return ok()
      }
      case 'set_group_add_request':
        this.requests.push({ flag: String(params.flag), approve: params.approve, reason: params.reason ?? '' })
        return ok()
      case 'send_group_msg':
      case 'send_private_msg': {
        if (this.failSend) return fail(1200)
        const isGroup = action === 'send_group_msg'
        this.sent.push({ kind: isGroup ? 'group' : 'private', target: String(isGroup ? params.group_id : params.user_id), ...flatten(params.message), raw: params.message })
        return ok({ message_id: ++this.messageId })
      }
      case 'get_group_system_msg':
        return ok(this.systemMsg)
    }
    return ok()
  }
}

function flatten(message: unknown): { text: string; ats: string[] } {
  const ats: string[] = []
  if (typeof message === 'string') return { text: message, ats }
  let text = ''
  for (const seg of (message as any[]) ?? []) {
    if (seg.type === 'text') text += seg.data.text
    else if (seg.type === 'at') {
      ats.push(String(seg.data.qq))
      text += `@${seg.data.qq}`
    } else text += `[${seg.type}]`
  }
  return { text, ats }
}

// ------------------------------------------------------------------ 组装

export interface Env {
  app: Context
  bot: OneBotBot<Context>
  guard: Guard
  aa: FakeAA
  qq: FakeQQ
  clock: { now: number }
  config: Config
  /** 模拟 OneBot 上报一个事件。 */
  emit(payload: Record<string, unknown>): Promise<void>
  /** 以某个 QQ 的身份私聊机器人（或在群里）发一条消息，返回机器人的回复。 */
  say(userId: string, text: string, groupId?: string): Promise<string[]>
  /** 把排队的运维通知发出去，返回运维群收到的消息文本。 */
  adminMessages(): Promise<string[]>
  stop(): Promise<void>
}

export function baseMembers(extra: FakeMember[] = []): FakeMember[] {
  return [
    { user_id: +OWNER, role: 'owner', card: '群主', nickname: 'owner' },
    { user_id: +ADMIN, role: 'admin', card: '管理员', nickname: 'admin' },
    { user_id: +BOT, role: 'admin', card: '机器人', nickname: 'bot' },
    ...extra,
  ]
}

export function plainMember(qq: string, card = '', nickname = `昵称${qq}`): FakeMember {
  return { user_id: +qq, role: 'member', card, nickname }
}

export async function setup(configPatch: Partial<Config> = {}, options: { start?: (aa: FakeAA, qq: FakeQQ) => void } = {}): Promise<Env> {
  const aa = new FakeAA()
  await aa.start()
  const qq = new FakeQQ()
  qq.addGroup(GROUP, baseMembers())
  qq.addGroup(ADMIN_GROUP, baseMembers([plainMember(OPERATOR, '运维')]))
  aa.allow(OWNER, '[IGC] 群主')
  aa.allow(ADMIN, '[IGC] 管理员')
  options.start?.(aa, qq)

  const clock = { now: Date.now() }
  const config: Config = {
    aaBaseUrl: aa.baseUrl,
    keyId: KEY_ID,
    secret: SECRET,
    timeoutSeconds: 5,
    bindUrl: 'https://auth.example.com/services/',
    botId: '',
    adminGroupId: ADMIN_GROUP,
    operators: [OPERATOR],
    whitelist: [],
    defaultMode: 'report',
    groupModes: [],
    autoReject: true,
    rejectTemplate: '{hint}。绑定地址：{url}',
    inviteHandling: 'same',
    catchUpRequests: true,
    patrolIntervalHours: 6,
    eventPollSeconds: 60,
    syncCards: true,
    graceHours: 48,
    remindTime: '19:30',
    remindTemplate: '以下成员还没有满足本群的要求，请尽快在联盟 AA 完成 QQ 绑定：{url}\n{list}',
    warnTemplate: '以下成员还没有满足本群的要求，请在截止时间前完成绑定，否则会被移出本群：{url}\n{list}',
    markCards: true,
    markPrefix: '【SPY】',
    kickAnnounce: true,
    kickAnnounceTemplate: '以下成员因未满足本群的要求已被移出：{list}\n完成绑定后可以重新申请入群：{url}',
    breakerCount: 5,
    breakerPercent: 10,
    kickPerHour: 10,
    ...configPatch,
  }

  const app = new Context()
  app.plugin(HTTP as any)
  app.plugin(Memory)
  let bot!: OneBotBot<Context>
  app.plugin({
    name: 'fake-onebot',
    apply(ctx: Context) {
      bot = new OneBotBot(ctx, { selfId: BOT, protocol: 'none', advanced: { splitMixedContent: true } } as any)
      ;(bot.internal as any)._request = async (action: string, params: any) => qq.handle(action, params)
    },
  })
  let guard!: Guard
  app.plugin({
    name: 'aaqqbot-test',
    inject: ['database', 'http'],
    apply(ctx: Context) {
      guard = new Guard(ctx, config, { timers: false, retryDelays: [], cardDelayMs: 0, kickDelayMs: 0, groupDelayMs: 0, now: () => clock.now })
      guard.install()
      registerCommands(ctx, guard)
    },
  })
  await app.start()
  bot.online()
  await waitFor(() => guard.started !== null)
  await guard.started
  // 运维（权限等级 3）
  await app.database.createUser('onebot', OPERATOR, { authority: 3 })
  aa.requests = [] // 启动时的 health、groups 请求不算
  qq.calls = []

  let messageId = 1000
  const env: Env = {
    app, bot, guard, aa, qq, clock, config,
    async emit(payload) {
      await OneBot.dispatchSession(bot as any, { self_id: +BOT, time: Math.floor(Date.now() / 1000), ...payload } as any)
    },
    async say(userId, text, groupId) {
      const before = qq.sent.length
      const payload: any = groupId
        ? { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: +groupId, user_id: +userId, message: text, raw_message: text, message_id: ++messageId, font: 0, sender: { user_id: +userId, nickname: 'u', role: userId === OWNER ? 'owner' : 'member' } }
        : { post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: +userId, message: text, raw_message: text, message_id: ++messageId, font: 0, sender: { user_id: +userId, nickname: 'u' } }
      await env.emit(payload)
      await sleep(200)
      return qq.sent.slice(before).filter((m) => m.target === (groupId ?? userId)).map((m) => m.text)
    },
    async adminMessages() {
      await guard.notifier.flush()
      return qq.groupMessages(ADMIN_GROUP).map((m) => m.text)
    },
    async stop() {
      guard.dispose()
      await app.stop()
      await aa.stop()
    },
  }
  return env
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await sleep(10)
  }
}
