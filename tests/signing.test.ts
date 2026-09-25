import { describe, expect, it } from 'vitest'
import { sha256Hex, sign, signingString, makeNonce } from '../src/signing'

// aa-qqbot 仓库 API.md 第 2.5 节的签名测试样例，结果必须逐字相同。
const SECRET = 'koishi-test-vector-secret-0123456789ABCDEFGHIJ'
const TIMESTAMP = '1767225600'

describe('签名测试样例（API.md 2.5）', () => {
  it('样例 1：纯 ASCII 请求体', () => {
    const body = '{"group_id":"123456789","qqs":["10001","20002"],"full_roster":false}'
    expect(sha256Hex(body)).toBe('e5eaf15236bbfb41e46f96a6413ab601de021f05391bb63bbd331da3057315cd')
    expect(signingString('/qqbot/api/v1/check/', TIMESTAMP, 'Zq3vN8xK2mP5tR7w', body)).toBe(
      'POST\n/qqbot/api/v1/check/\n1767225600\nZq3vN8xK2mP5tR7w\ne5eaf15236bbfb41e46f96a6413ab601de021f05391bb63bbd331da3057315cd',
    )
    expect(sign(SECRET, '/qqbot/api/v1/check/', TIMESTAMP, 'Zq3vN8xK2mP5tR7w', body)).toBe(
      '4babcb45e2477890050b37e838f2efc239b550fccae9c8b5cb7127ddf36767e4',
    )
  })

  it('样例 2：请求体含中文（UTF-8）', () => {
    const body = '{"qq":"10001","text":"我是凯拉 QQ-ABC234"}'
    expect(Buffer.from(body, 'utf8').toString('hex')).toBe(
      '7b227171223a223130303031222c2274657874223a22e68891e698afe587afe68b892051512d414243323334227d',
    )
    expect(sha256Hex(body)).toBe('0420addccba85a2add4a1260989df656a91b169a103a3ce56dc05e6c5e1e6e68')
    expect(sign(SECRET, '/qqbot/api/v1/claim/', TIMESTAMP, 'Nonce_For-Vector-2', body)).toBe(
      '8ac11ec05b15b17b7449676b2f2bb3c7395bd2578ac396389e4af3854af11be2',
    )
  })

  it('JSON.stringify 的结果与样例 2 的请求体逐字相同', () => {
    expect(JSON.stringify({ qq: '10001', text: '我是凯拉 QQ-ABC234' })).toBe('{"qq":"10001","text":"我是凯拉 QQ-ABC234"}')
  })

  it('空请求体的哈希', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('随机数符合格式且每次不同', () => {
    const a = makeNonce()
    const b = makeNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
    expect(a).not.toBe(b)
  })
})
