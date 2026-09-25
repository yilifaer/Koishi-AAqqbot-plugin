// 完整流程测试：真实的 Koishi + adapter-onebot，模拟的 AA 和 LLBot。
// 对应交接文档 README §9.5 第 9–18 条、KOISHI_START 第 9 节。

import { afterEach, describe, expect, it } from 'vitest'
import type { Mode } from '../src/config'
import {
  ADMIN, ADMIN_GROUP, BOT, Env, GROUP, OPERATOR, OTHER_GROUP, OWNER, plainMember, setup, sleep,
} from './harness'

let env: Env
afterEach(async () => {
  await env?.stop()
})

const HOUR = 3600_000

function setMode(mode: Mode, groupId = GROUP) {
  env.config.groupModes = [{ groupId, mode }]
}

/** 设好模式，跑一轮 report，管理员确认。 */
async function confirmMode(mode: Mode) {
  setMode(mode)
  await env.guard.runPatrol()
  expect(await env.guard.confirm(GROUP, OPERATOR)).toContain('已确认')
}

function addMembers(...qqs: string[]) {
  const group = env.qq.groups.get(GROUP)!
  for (const qq of qqs) group.set(qq, plainMember(qq, `名片${qq}`))
}

function requestEvent(qq: string, comment: string, extra: Record<string, unknown> = {}) {
  return env.emit({ post_type: 'request', request_type: 'group', sub_type: 'add', group_id: +GROUP, user_id: +qq, comment, flag: `flag-${qq}-${Math.random()}`, ...extra })
}

async function settle() {
  await sleep(150)
}

describe('巡检：report 模式', () => {
  it('提交完整名单（full_roster），发一条汇总，不改动群里任何东西', async () => {
    env = await setup()
    addMembers('40001', '40002')
    env.aa.allow('40001', '[IGC] 甲')
    await env.guard.runPatrol()
    const request = env.aa.last('check')!
    expect(request.body.full_roster).toBe(true)
    expect(request.body.qqs.sort()).toEqual([OWNER, ADMIN, BOT, '40001', '40002'].sort())
    expect(env.qq.actions('set_group_card')).toEqual([])
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    const messages = await env.adminMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('新发现不合格：名片40002(40002) 没有在 AA 绑定 QQ')
    expect(messages[0]).toContain('1 人的名片与 AA 不一致（report 模式不修改）')
  })

  it('设了 enforce 但没确认：按 report 执行，并提示怎么确认', async () => {
    env = await setup()
    addMembers('40001')
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_card')).toEqual([])
    const [message] = await env.adminMessages()
    expect(message).toContain('还没确认')
    expect(message).toContain(`aaqq.confirm ${GROUP}`)
  })

  it('不在 AA 受管列表里的群不巡检', async () => {
    env = await setup()
    env.qq.addGroup(OTHER_GROUP, [plainMember('40009')])
    await env.guard.runPatrol()
    expect(env.aa.requests.filter((r) => r.name === 'check').map((r) => r.body.group_id)).toEqual([GROUP])
  })

  it('off 模式的群不巡检', async () => {
    env = await setup()
    setMode('off')
    await env.guard.runPatrol()
    expect(env.aa.count('check')).toBe(0)
  })
})

describe('完整流程：remind → enforce → 移出', () => {
  it('确认 → 加标记 → 每日提醒 → 宽限期到 → 实时复核后移出 → 公告', async () => {
    env = await setup()
    addMembers('40001', '40002')
    env.qq.member(GROUP, '40001')!.card = '张三'
    env.aa.allow('40002', '[IGC] 李四')

    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    // 不合格的人名片加标记，合格的人同步名片
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】张三')
    expect(env.qq.member(GROUP, '40002')!.card).toBe('[IGC] 李四')
    const tracked = await env.guard.store.tracked(GROUP)
    expect(tracked.get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)

    // 每日提醒：@ 本人，带截止时间
    await env.guard.runReminders()
    const reminder = env.qq.groupMessages(GROUP).at(-1)!
    expect(reminder.ats).toEqual(['40001'])
    expect(reminder.text).toContain('截止')
    expect(reminder.text).toContain('https://auth.example.com/services/')

    // 47 小时后：还没到
    env.clock.now += 47 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()

    // 49 小时后：移出，不拉黑
    env.clock.now += 2 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    const kick = env.qq.actions('set_group_kick')[0]
    expect(kick.params).toMatchObject({ user_id: 40001, reject_add_request: false })
    // 移出前实时复核过
    expect(env.qq.actions('get_group_member_info').some((c) => c.params.user_id === 40001 && c.params.no_cache === true)).toBe(true)
    expect(env.qq.groupMessages(GROUP).at(-1)!.text).toContain('已被移出：【SPY】张三')
    const messages = await env.adminMessages()
    expect(messages.join('\n')).toContain('移出 1 人')
    expect(await env.guard.store.tracked(GROUP)).toEqual(new Map())
  })

  it('宽限期里绑定好了：取消宽限，名片改成 AA 的，不会被移出', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    env.aa.allow('40001', '[IGC] 张三')
    env.clock.now += 49 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 张三')
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('提醒前再问一次 AA：刚绑定的人不会被 @', async () => {
    env = await setup()
    addMembers('40001', '40002')
    await confirmMode('remind')
    await env.guard.runPatrol([GROUP])
    env.aa.allow('40001', '[IGC] 张三')
    await env.guard.runReminders()
    const reminder = env.qq.groupMessages(GROUP).at(-1)!
    expect(reminder.ats).toEqual(['40002'])
    expect(reminder.text).not.toContain('截止') // remind 模式不写截止时间
  })

  it('remind 模式永远不移出', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('remind')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 30 * 24 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('已确认 remind、改成 enforce 但还没确认：继续按 remind 执行，标记不会被撤掉', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('remind')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    setMode('enforce')
    env.clock.now += 100 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('暂时按 remind 执行')
    // 确认后才开始 enforce 的宽限期（从现在起 48 小时）
    await env.guard.confirm(GROUP, OPERATOR)
    await env.guard.runPatrol([GROUP])
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)
  })

  it('没有近期巡检报告时不能确认', async () => {
    env = await setup()
    setMode('enforce')
    expect(await env.guard.confirm(GROUP, OPERATOR)).toContain('没有成功的巡检报告')
  })

  it('降级立即生效，再升级需要重新确认', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    setMode('report')
    await env.guard.runPatrol()
    // 降到 report：标记撤掉
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    expect((await env.adminMessages()).at(-1)).toContain('还没确认')
  })
})

describe('永不处置的人', () => {
  it('群主、管理员、机器人、白名单：判为 deny、宽限期已过也不移出', async () => {
    env = await setup({ whitelist: [' 40001 '] }) // 带空格也能匹配
    addMembers('40001')
    env.aa.deny(OWNER)
    env.aa.deny(ADMIN)
    await confirmMode('enforce')
    await env.guard.store.saveTracked([OWNER, ADMIN, BOT, '40001'].map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(0), graceUntil: new Date(0), marked: false, lastRemindedAt: null,
    })))
    await env.guard.runPatrol([GROUP])
    env.clock.now += 100 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect(env.qq.actions('set_group_card').filter((c) => [OWNER, ADMIN, BOT, '40001'].includes(String(c.params.user_id)))).toEqual([])
  })

  it('移出前实时复核：这个人刚被设为管理员 → 跳过', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 49 * HOUR
    // 巡检拿到的名单里还是普通成员，但实时查询时已经是管理员
    const original = env.qq.handle.bind(env.qq)
    env.qq.handle = (action, params) => {
      const result = original(action, params)
      if (action === 'get_group_member_info' && params.user_id === 40001) result.data = { ...result.data, role: 'admin' }
      return result
    }
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('复核后跳过 1 人')
  })

  it('需要人工处理（review，例如冲突）：永不处置', async () => {
    env = await setup()
    addMembers('40001')
    env.aa.review('40001', 'CONFLICT')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 100 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    expect((await env.adminMessages()).at(-1)).toContain('需人工处理')
  })
})

describe('AA 出问题时绝不处置', () => {
  const failures: Array<[string, Parameters<Env['aa']['override']>[1]]> = [
    ['302 跳到登录页', { status: 302, body: '', headers: { Location: '/account/login/' } }],
    ['200 但是网页', { status: 200, body: '<html></html>', headers: { 'Content-Type': 'text/html' } }],
    ['500', { status: 500, body: '{"ok":false,"error":"internal_error"}' }],
    ['连接断开', { status: 0, body: '', destroy: true }],
    ['401', { status: 401, body: '{"ok":false,"error":"bad_signature"}' }],
  ]
  for (const [name, response] of failures) {
    it(`${name}：宽限期已过的人也不移出，并报警`, async () => {
      env = await setup()
      addMembers('40001')
      await confirmMode('enforce')
      await env.guard.runPatrol([GROUP])
      env.clock.now += 49 * HOUR
      env.aa.override('check', response)
      await env.guard.runPatrol()
      expect(env.qq.actions('set_group_kick')).toEqual([])
      const messages = (await env.adminMessages()).join('\n')
      expect(messages).toContain('AA 连接出问题')
      expect(messages).toContain('不做任何处置')
    })
  }

  it('AA 一直连不上：只报警一次，恢复后通知一次', async () => {
    env = await setup()
    env.aa.override('check', { status: 500, body: '{"ok":false}' })
    await env.guard.runPatrol()
    await env.guard.runPatrol()
    env.aa.overrides.clear()
    await env.guard.runPatrol()
    const messages = (await env.adminMessages()).join('\n')
    expect(messages.match(/AA 连接出问题/g)).toHaveLength(1)
    expect(messages.match(/AA 已恢复/g)).toHaveLength(1)
  })
})

describe('熔断', () => {
  it('AA 误配置、大批人变成 deny：整群停止处置，申请也不拒绝；管理员确认后才处置', async () => {
    env = await setup()
    const people = ['40001', '40002', '40003', '40004', '40005', '40006', '40007', '40008']
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `[IGC] ${qq}`)
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 40001')

    // AA 被改错：全员 NO_ACCESS
    for (const qq of people) env.aa.deny(qq, 'NO_ACCESS')
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_card').filter((c) => String(c.params.card).startsWith('【SPY】'))).toEqual([])
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    const alarm = (await env.adminMessages()).join('\n')
    expect(alarm).toContain('⛔ 熔断')

    // 熔断期间：不合格的申请不拒绝
    await requestEvent('40100', '')
    await settle()
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('熔断中')

    // 下一轮仍然熔断，时间再长也不移出
    env.clock.now += 100 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])

    // 管理员确认 → 这一轮不触发熔断，开始宽限
    expect(await env.guard.confirm(GROUP, OPERATOR)).toContain('解除熔断')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】[IGC] 40001')
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })
})

describe('入群申请', () => {
  it('带正确验证码：同意；入群后设名片（remind/enforce 模式）', async () => {
    env = await setup()
    await confirmMode('remind')
    env.aa.codes.set('7K3F9P', '40001')
    await requestEvent('40001', '我是凯拉 QQ-7K3F9P')
    await settle()
    expect(env.aa.last('claim')!.body).toEqual({ qq: '40001', text: '我是凯拉 QQ-7K3F9P', group_id: GROUP })
    expect(env.qq.requests).toEqual([expect.objectContaining({ approve: true })])
    // 入群
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', ''))
    await env.emit({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', group_id: +GROUP, user_id: 40001, operator_id: +BOT })
    await settle()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 新人40001')
  })

  it('验证信息原文照传（包括 < & 这类字符）', async () => {
    env = await setup()
    await requestEvent('40001', 'a<b>&c QQ-ABC234')
    await settle()
    expect(env.aa.last('claim')!.body.text).toBe('a<b>&c QQ-ABC234')
  })

  it('没有验证码但已经是合格成员（老成员换号等）：同意', async () => {
    env = await setup()
    env.aa.allow('40001', '[IGC] 甲')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([expect.objectContaining({ approve: true })])
  })

  it('不合格、report 模式：不拒绝，留给管理员', async () => {
    env = await setup()
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('留给管理员处理')
  })

  it('不合格、enforce 模式：拒绝，理由里有原因和绑定网址', async () => {
    env = await setup()
    await confirmMode('enforce')
    await requestEvent('40001', 'QQ-ZZZZZZ')
    await settle()
    expect(env.qq.requests).toHaveLength(1)
    const { approve, reason } = env.qq.requests[0]
    expect(approve).toBe(false)
    expect(reason).toContain('验证码不对')
    expect(reason).toContain('https://auth.example.com/services/')
  })

  it('关闭自动拒绝：不拒绝', async () => {
    env = await setup({ autoReject: false })
    await confirmMode('enforce')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
  })

  it('需要人工处理（review）：不同意也不拒绝', async () => {
    env = await setup()
    await confirmMode('enforce')
    env.aa.review('40001')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
  })

  it('AA 连不上：不同意也不拒绝，报告管理员', async () => {
    env = await setup()
    await confirmMode('enforce')
    env.aa.override('claim', { status: 502, body: 'Bad Gateway' })
    await requestEvent('40001', '')
    await settle()
    await sleep(2200) // 等一次重试
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('AA 无法判断')
  })

  it('不受管的群：完全不理', async () => {
    env = await setup()
    await env.emit({ post_type: 'request', request_type: 'group', sub_type: 'add', group_id: +OTHER_GROUP, user_id: 40001, comment: 'QQ-7K3F9P', flag: 'x1' })
    await settle()
    expect(env.aa.count('claim')).toBe(0)
    expect(env.qq.requests).toEqual([])
  })

  it('邀请入群 + 设为「留给管理员」：不问 AA', async () => {
    env = await setup({ inviteHandling: 'manual' })
    await requestEvent('40001', '', { invitor_id: 40009 })
    await settle()
    expect(env.aa.count('claim')).toBe(0)
    expect((await env.adminMessages()).at(-1)).toContain('邀请')
  })

  it('邀请入群 + 默认设置：和普通申请一样问 AA', async () => {
    env = await setup()
    env.aa.allow('40001', '[IGC] 甲')
    await requestEvent('40001', '', { invitor_id: 40009 })
    await settle()
    expect(env.qq.requests).toEqual([expect.objectContaining({ approve: true })])
  })

  it('同一个申请只处理一次', async () => {
    env = await setup()
    env.aa.allow('40001', '[IGC] 甲')
    const payload = { post_type: 'request', request_type: 'group', sub_type: 'add', group_id: +GROUP, user_id: 40001, comment: '', flag: 'same-flag' }
    await env.emit(payload)
    await env.emit(payload)
    await settle()
    expect(env.aa.count('claim')).toBe(1)
  })

  it('机器人重新上线：补处理积压的申请', async () => {
    env = await setup()
    env.aa.codes.set('ABC234', '40001')
    env.qq.systemMsg = {
      join_requests: [
        { request_id: 777, requester_uin: 40001, requester_nick: 'x', message: 'QQ-ABC234', group_id: +GROUP, checked: false },
        { request_id: 778, requester_uin: 40002, requester_nick: 'y', message: '', group_id: +GROUP, checked: true },
        { request_id: 779, requester_uin: 40003, requester_nick: 'z', message: '', group_id: +OTHER_GROUP, checked: false },
      ],
      invited_requests: [],
    }
    await env.guard.catchUpRequests(env.bot as any)
    expect(env.qq.requests).toEqual([{ flag: '777', approve: true, reason: '' }])
  })
})

describe('新成员直接进群（没有经过申请）', () => {
  it('合格：设名片', async () => {
    env = await setup()
    await confirmMode('remind')
    env.aa.allow('40001', '[IGC] 甲')
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', ''))
    await env.guard.handleNewMember(env.bot as any, GROUP, '40001')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 甲')
  })

  it('不合格（remind 模式）：加标记，并立即 @ 提醒', async () => {
    env = await setup()
    await confirmMode('remind')
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', '新人'))
    await env.guard.handleNewMember(env.bot as any, GROUP, '40001')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】新人')
    expect(env.qq.groupMessages(GROUP).at(-1)!.ats).toEqual(['40001'])
  })

  it('不合格（report 模式）：只报告', async () => {
    env = await setup()
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', '新人'))
    await env.guard.handleNewMember(env.bot as any, GROUP, '40001')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('新人')
    expect(env.qq.groupMessages(GROUP)).toEqual([])
  })
})

describe('AA 变化（事件）', () => {
  it('第一次运行：把已有事件拉完只记游标，然后安排一次完整巡检', async () => {
    env = await setup()
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }, { id: 2, kind: 'card', qq: '40002' }]
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv('cursor')).toBe(2)
    expect(env.aa.count('check')).toBe(0)
    expect((env.guard as any).patrolQueue).toBe('all')
  })

  it('recheck：只复查相关的人（不带 full_roster），按群合并成一次 check', async () => {
    env = await setup()
    addMembers('40001', '40002', '40003')
    for (const qq of ['40001', '40002', '40003']) env.aa.allow(qq, `[IGC] ${qq}`)
    await confirmMode('remind')
    await env.guard.runPatrol([GROUP])
    await env.guard.store.setKv('cursor', 0)
    env.aa.requests = []
    env.aa.deny('40001', 'NO_ACCESS') // 40002 仍然合格
    env.aa.events = [
      { id: 1, kind: 'recheck', qq: '40001' },
      { id: 2, kind: 'recheck', qq: '40002' },
      { id: 3, kind: 'recheck', qq: '40001' },
      { id: 4, kind: 'recheck', qq: '49999' }, // 不在群里
    ]
    await env.guard.pollEvents()
    const checks = env.aa.requests.filter((r) => r.name === 'check')
    expect(checks).toHaveLength(1)
    expect(checks[0].body.full_roster).toBe(false)
    expect(checks[0].body.qqs.sort()).toEqual(['40001', '40002'])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】[IGC] 40001')
    expect(env.qq.member(GROUP, '40002')!.card).toBe('[IGC] 40002')
    expect(await env.guard.store.getKv('cursor')).toBe(4)
  })

  it('事件通道也有熔断：小群里一下子多人变成 deny → 熔断', async () => {
    env = await setup()
    addMembers('40001', '40002', '40003')
    for (const qq of ['40001', '40002', '40003']) env.aa.allow(qq, `[IGC] ${qq}`)
    await confirmMode('remind')
    await env.guard.runPatrol([GROUP])
    await env.guard.store.setKv('cursor', 0)
    for (const qq of ['40001', '40002', '40003']) env.aa.deny(qq, 'NO_ACCESS')
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }, { id: 2, kind: 'recheck', qq: '40002' }, { id: 3, kind: 'recheck', qq: '40003' }]
    await env.guard.pollEvents()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 40001')
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('⛔ 熔断')
  })

  it('复查时 AA 出错：游标不前进，下次重来', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    await env.guard.store.setKv('cursor', 0)
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }]
    env.aa.override('check', { status: 500, body: '{}' }, 1)
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv('cursor')).toBe(0)
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv('cursor')).toBe(1)
  })

  it('recheck_all：安排完整巡检；groups：重新拉取群列表', async () => {
    env = await setup()
    await env.guard.store.setKv('cursor', 0)
    env.aa.groups.push({ group_id: OTHER_GROUP, name: '旗舰群', kind: 'role' })
    env.aa.events = [{ id: 1, kind: 'groups', qq: '' }, { id: 2, kind: 'recheck_all', qq: '' }]
    await env.guard.pollEvents()
    expect(env.guard.groups.map((g) => g.groupId)).toEqual([GROUP, OTHER_GROUP])
    expect((env.guard as any).patrolQueue).toBe('all')
    expect(await env.guard.store.getKv('cursor')).toBe(2)
  })
})

describe('暂停与中止', () => {
  it('暂停时不巡检、不处理申请；状态保存在数据库里', async () => {
    env = await setup()
    await env.guard.setPaused(true, OPERATOR)
    expect(await env.guard.runPatrol()).toBe('paused')
    env.aa.allow('40001', '[IGC] 甲')
    await requestEvent('40001', '')
    await settle()
    expect(env.aa.count('claim')).toBe(0)
    expect(env.qq.requests).toEqual([])
    expect(await env.guard.store.getKv('paused')).toBe(true)
    await env.guard.setPaused(false, OPERATOR)
    expect(await env.guard.runPatrol()).toBe('done')
  })

  it('巡检进行中暂停：立即中止，不再处置', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 49 * HOUR
    env.aa.override('check', { status: 200, body: '{}', delayMs: 1000 })
    const patrol = env.guard.runPatrol()
    await sleep(100)
    await env.guard.setPaused(true, OPERATOR)
    await patrol
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('巡检已中止')
  })

  it('同一时间只有一轮巡检', async () => {
    env = await setup()
    env.aa.override('check', { status: 500, body: '{}', delayMs: 300 }, 1)
    const first = env.guard.runPatrol()
    expect(await env.guard.runPatrol()).toBe('busy')
    await first
  })

  it('插件停用：正在进行的巡检中止', async () => {
    env = await setup()
    env.aa.override('check', { status: 200, body: '{}', delayMs: 1000 })
    const patrol = env.guard.runPatrol()
    await sleep(100)
    env.guard.dispose()
    expect(await patrol).toBe('done')
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })
})

describe('通知', () => {
  it('发送通知失败不影响移出，也不影响记录', async () => {
    env = await setup()
    addMembers('40001')
    await confirmMode('enforce')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 49 * HOUR
    env.qq.failSend = true
    await env.guard.runPatrol()
    await env.adminMessages()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(1)
  })

  it('群名、名片里的 <at type="all"/> 按纯文本发送', async () => {
    env = await setup()
    env.aa.groups = [{ group_id: GROUP, name: '<at type="all"/>群', kind: 'fixed' }]
    await env.guard.refreshGroups()
    addMembers('40001')
    env.qq.member(GROUP, '40001')!.card = '<at id="all"/><execute>aaqq.pause</execute>'
    await env.guard.runPatrol()
    await env.adminMessages()
    const message = env.qq.groupMessages(ADMIN_GROUP).at(-1)!
    expect(message.ats).toEqual([])
    expect(message.text).toContain('<at type="all"/>群')
    expect(message.text).toContain('<execute>aaqq.pause</execute>')
    expect(env.guard.paused).toBe(false)
  })

  it('运维群同时是受管群：不发通知', async () => {
    env = await setup()
    env.aa.groups.push({ group_id: ADMIN_GROUP, name: '运维群', kind: 'fixed' })
    await env.guard.refreshGroups()
    await env.guard.runPatrol()
    expect(await env.adminMessages()).toEqual([])
    expect(await env.guard.statusText()).toContain('运维群同时是受管群')
  })
})

describe('管理命令鉴权', () => {
  it('运维私聊：可以用', async () => {
    env = await setup()
    const reply = await env.say(OPERATOR, 'aaqq.status')
    expect(reply.join('\n')).toContain('受管群')
  })

  it('运维在运维群里：可以用', async () => {
    env = await setup()
    const reply = await env.say(OPERATOR, 'aaqq.status', ADMIN_GROUP)
    expect(reply.join('\n')).toContain('受管群')
  })

  it('不在运维名单里：拒绝', async () => {
    env = await setup()
    await env.app.database.createUser('onebot', '40001', { authority: 4 })
    const reply = await env.say('40001', 'aaqq.pause')
    expect(reply.join('\n')).toContain('不在运维名单')
    expect(env.guard.paused).toBe(false)
  })

  it('在运维名单里但权限等级不够：拒绝', async () => {
    env = await setup({ operators: [OPERATOR, '40001'] })
    await env.app.database.createUser('onebot', '40001', { authority: 1 })
    const reply = await env.say('40001', 'aaqq.pause')
    expect(reply.join('\n')).toContain('权限不足')
    expect(env.guard.paused).toBe(false)
  })

  it('在受管群里发管理命令：不回应', async () => {
    env = await setup()
    const reply = await env.say(OPERATOR, 'aaqq.pause', GROUP)
    expect(reply).toEqual([])
    expect(env.guard.paused).toBe(false)
  })

  it('群主（群管理员）但不在运维名单：拒绝', async () => {
    env = await setup()
    await env.app.database.createUser('onebot', OWNER, { authority: 1 })
    const reply = await env.say(OWNER, 'aaqq.pause', ADMIN_GROUP)
    expect(reply.join('\n')).toContain('不在运维名单')
    expect(env.guard.paused).toBe(false)
  })

  it('pause / resume / confirm / check 命令', async () => {
    env = await setup()
    addMembers('40001')
    expect((await env.say(OPERATOR, 'aaqq.pause')).join()).toContain('已暂停')
    expect(env.guard.paused).toBe(true)
    expect((await env.say(OPERATOR, 'aaqq.resume')).join()).toContain('已恢复')
    expect(env.guard.paused).toBe(false)
    expect((await env.say(OPERATOR, 'aaqq.check 40001')).join()).toContain('不合格：没有在 AA 绑定 QQ')
    expect((await env.say(OPERATOR, 'aaqq.check abc')).join()).toContain('用法')
    setMode('enforce')
    await env.guard.runPatrol()
    expect((await env.say(OPERATOR, `aaqq.confirm ${GROUP}`)).join()).toContain('模式升级为 enforce')
  })
})
