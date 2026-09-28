// 完整流程测试：真实的 Koishi + adapter-onebot，模拟的 AA 和 LLBot。
// 对应交接文档 README §9.5 第 9–18 条、KOISHI_START 第 9 节。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OneBot } from 'koishi-plugin-adapter-onebot'
import type { Mode } from '../src/config'
import { charLength } from '../src/util'
import {
  ADMIN, ADMIN_GROUP, BOT, Env, GROUP, OPERATOR, OTHER_GROUP, OWNER, plainMember, setup, sleep, waitFor,
} from './harness'

let env: Env
afterEach(async () => {
  await env?.stop()
})

const HOUR = 3600_000

function setMode(mode: Mode, groupId = GROUP) {
  env.config.groupModes = [{ groupId, mode }]
}

/** 设好模式，跑一轮巡检（0.2.0 起改模式下一轮直接生效）。 */
async function enableMode(mode: Mode) {
  setMode(mode)
  await env.guard.runPatrol()
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

/** 截止时间过去，并且在那之前刚又提醒过一次（每天都会提醒）。 */
async function passDeadline() {
  env.clock.now += 49 * HOUR
  await env.guard.runReminders()
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
    expect(messages[0]).toContain('成员 4（不含机器人）：合格 3｜不合格 1（新发现 1）｜需人工 0｜无法判断 0')
    expect(messages[0]).toContain('新发现不合格 1 人\n【没有在 AA 绑定 QQ】\n· 名片40002(40002)')
    expect(messages[0]).toContain('· 3 人的名片与 AA 不一致（report 模式不修改）') // 40001、群主、管理员
  })

  it('设了 enforce：下一轮直接生效，报告里有「模式已从 report … 改为 enforce」', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    const messages = await env.adminMessages()
    expect(messages.at(-1)).toContain('ℹ 模式已从 report（只报告）改为 enforce（提醒并移出），本轮开始生效')
    expect(messages.join('\n')).not.toMatch(/还没确认|等待确认/)
  })

  it('旧数据兼容：0.1.x 记的 confirmedMode 是 report、配置是 enforce → 第一轮就按 enforce 执行', async () => {
    env = await setup()
    addMembers('40001')
    await env.app.database.upsert('aaqqbot_group', [{
      groupId: GROUP, confirmedMode: 'report', lastPatrolAt: new Date(env.clock.now - HOUR), lastPatrolOk: true, lastRosterSize: 4,
    }])
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect((await env.adminMessages()).at(-1)).toContain('ℹ 模式已从 report（只报告）改为 enforce（提醒并移出）')
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

    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    // 不合格的人名片加标记，合格的人同步名片
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】张三')
    expect(env.qq.member(GROUP, '40002')!.card).toBe('[IGC] 李四')
    // 截止时间要等第一次成功提醒时才定
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil).toBeNull()

    // 每日提醒：@ 本人，带截止时间
    await env.guard.runReminders()
    const reminder = env.qq.groupMessages(GROUP).at(-1)!
    expect(reminder.ats).toEqual(['40001'])
    expect(reminder.text).toContain('截止')
    expect(reminder.text).toContain('https://auth.example.com/services/')
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)

    // 第二天的提醒；47 小时后巡检：还没到
    env.clock.now += 24 * HOUR
    await env.guard.runReminders()
    env.clock.now += 23 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()

    // 第三天的提醒；49 小时后巡检：移出，不拉黑
    env.clock.now += 1 * HOUR
    await env.guard.runReminders()
    env.clock.now += 1 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    const kick = env.qq.actions('set_group_kick')[0]
    expect(kick.params).toMatchObject({ user_id: 40001, reject_add_request: false })
    // 移出前实时复核过
    expect(env.qq.actions('get_group_member_info').some((c) => c.params.user_id === 40001 && c.params.no_cache === true)).toBe(true)
    expect(env.qq.groupMessages(GROUP).at(-1)!.text).toContain('已被移出：张三')
    const messages = await env.adminMessages()
    expect(messages.join('\n')).toContain('移出 1 人')
    expect(await env.guard.store.tracked(GROUP)).toEqual(new Map())
  })

  it('宽限期里绑定好了：取消宽限，名片改成 AA 的，不会被移出', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    env.aa.allow('40001', '[IGC] 张三')
    env.clock.now += 49 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 张三')
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('提醒前再问一次 AA：刚绑定的人不会被 @', async () => {
    env = await setup({ breakerPercent: 100 }) // 阈值 5：两个人一起开始处置不进冷静期
    addMembers('40001', '40002')
    await enableMode('remind')
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
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    env.clock.now += 30 * 24 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('remind → enforce：下一轮直接生效；截止时间仍在第一次成功提醒时才定', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    setMode('enforce')
    env.clock.now += 100 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('ℹ 模式已从 remind（提醒，不踢）改为 enforce（提醒并移出），本轮开始生效')
    // 第一次带截止时间的提醒才开始 enforce 的宽限期（从那时起 48 小时）
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil).toBeNull()
    await env.guard.runReminders()
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)
  })

  it('不在冷静期时 aaqq.confirm：回复不需要确认', async () => {
    env = await setup()
    setMode('enforce')
    expect(await env.guard.confirm(GROUP, OPERATOR)).toBe('联盟聊天群（111111111） 现在不在冷静期。0.2.0 起改模式直接生效，不需要确认。')
  })

  it('降级立即撤标记（记录保留）；再升级下一轮直接生效', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    setMode('report')
    await env.guard.runPatrol()
    // 降到 report：标记撤掉，记录保留（以后不会再被报成「新发现」）
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    expect((await env.guard.store.tracked(GROUP)).get('40001')).toMatchObject({ marked: false, activeSince: null, graceUntil: null })
    expect((await env.adminMessages()).at(-1)).toContain('仍不合格 1 人')
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.activeSince).not.toBeNull()
  })
})

describe('永不处置的人', () => {
  for (const [botRole, markAdmins] of [['admin', false], ['owner', false], ['admin', true], ['owner', true]] as const) {
    const title = markAdmins
      ? '「群主/管理员也加标记」打开时（默认）：群主、管理员只加标记和提醒；机器人、白名单不加标记、不 @；宽限期已过也都不移出'
      : '「群主/管理员也加标记」关掉时：群主、管理员、机器人、白名单判为 deny、宽限期已过也不加标记、不 @、不移出'
    it(`${title}（机器人是${botRole === 'owner' ? '群主' : '管理员'}）`, async () => {
      env = await setup({ whitelist: [' 40001 '], markAdmins }) // 带空格也能匹配
      if (botRole === 'owner') {
        env.qq.member(GROUP, BOT)!.role = 'owner'
        env.qq.member(GROUP, OWNER)!.role = 'admin'
      }
      addMembers('40001')
      env.aa.deny(OWNER)
      env.aa.deny(ADMIN)
      await enableMode('enforce')
      await env.guard.store.saveTracked([OWNER, ADMIN, BOT, '40001'].map((qq) => ({
        groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(0), graceUntil: new Date(0), marked: false,
        lastRemindedAt: new Date(env.clock.now), activeSince: new Date(0),
      })))
      await env.guard.runPatrol([GROUP])
      // 机器人自己以前的跟踪记录会被删掉（K6）
      expect((await env.guard.store.tracked(GROUP)).has(BOT)).toBe(false)
      await env.guard.runReminders()
      env.clock.now += 100 * HOUR
      await env.guard.runPatrol()
      await env.guard.runReminders()
      await env.guard.runFastKicks()
      await env.guard.runPatrol()
      expect(env.qq.actions('set_group_kick')).toEqual([])
      const untouched = markAdmins ? [BOT, '40001'] : [OWNER, ADMIN, BOT, '40001']
      expect(env.qq.actions('set_group_card').filter((c) => untouched.includes(String(c.params.user_id)))).toEqual([])
      expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats).filter((qq) => untouched.includes(qq))).toEqual([])
      if (markAdmins) {
        // 群主（机器人是群主时原来的群主已改成管理员）、管理员带上标记，被单独提醒过
        expect(env.qq.member(GROUP, ADMIN)!.card.startsWith('【SPY】')).toBe(true)
        expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats)).toContain(ADMIN)
      }
      const rows = await env.guard.store.tracked(GROUP)
      for (const qq of [OWNER, ADMIN]) expect(rows.get(qq)?.graceUntil ?? null).toBeNull()
    })
  }

  it('群主 + 已过期的截止时间 + 默认设置（群主/管理员也加标记）+ enforce：不移出，截止时间清空（0.2.3 R9）', async () => {
    env = await setup()
    env.aa.deny(OWNER, 'NO_ACCESS')
    await enableMode('enforce')
    const now = env.clock.now
    await env.guard.store.saveTracked([{
      groupId: GROUP, qq: OWNER, reason: 'NO_ACCESS', firstDeniedAt: new Date(now - 72 * HOUR), graceUntil: new Date(now - HOUR),
      marked: true, lastRemindedAt: new Date(now - 60_000), activeSince: new Date(now - 72 * HOUR),
    }])
    await env.guard.runFastKicks()
    await env.guard.runPatrol()
    await env.guard.runReminders()
    env.clock.now += 3 * HOUR
    await env.guard.runFastKicks()
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect(env.qq.member(GROUP, OWNER)).toBeDefined()
    expect((await env.guard.store.tracked(GROUP)).get(OWNER)!.graceUntil).toBeNull()
  })

  it('移出前实时复核：这个人刚被设为管理员 → 跳过', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders()
    await passDeadline()
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
    await enableMode('enforce')
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
      await enableMode('enforce')
      await env.guard.runPatrol([GROUP])
      await env.guard.runReminders()
      await passDeadline()
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

describe('冷静期（K3）', () => {
  const EIGHT = ['40001', '40002', '40003', '40004', '40005', '40006', '40007', '40008']
  const LABEL = '联盟聊天群（111111111）'
  const spyCards = () => env.qq.actions('set_group_card').filter((c) => String(c.params.card).startsWith('【SPY】'))

  /** 8 个合格成员进入某个模式，然后 AA 被改错：全员 NO_ACCESS。 */
  async function massDeny(mode: Mode) {
    addMembers(...EIGHT)
    for (const qq of EIGHT) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode(mode)
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 40001')
    for (const qq of EIGHT) env.aa.deny(qq, 'NO_ACCESS')
    await env.guard.runPatrol()
  }

  it('全员变 deny → 冷静期开始；1 小时后仍冷静；满 6 小时还是这批人 → 自动结束、开始加标记', async () => {
    env = await setup()
    await massDeny('remind')
    expect(spyCards()).toEqual([])
    const state = await env.guard.store.groupState(GROUP)
    expect(state.holdSince).not.toBeNull()
    expect(JSON.parse(state.holdSet).sort()).toEqual(EIGHT)
    const alarm = (await env.adminMessages()).join('\n')
    expect(alarm).toContain(`⏸ 冷静期开始：${LABEL} 要开始处置的不合格成员有 8 人（超过阈值 1 人）。`)
    expect(alarm).toContain('还是这批人就自动继续，变化很大就重新冷静')
    expect(alarm).toContain('新发现不合格 8 人')
    expect(await env.guard.store.countAudit('cool-start', GROUP, new Date(0))).toBe(1)

    env.clock.now += HOUR
    await env.guard.runPatrol()
    expect(spyCards()).toEqual([])
    const cooling = (await env.adminMessages()).at(-1)!
    expect(cooling).toContain('⏸ 冷静中（要开始处置的不合格成员有 8 人（超过阈值 1 人））')
    expect(cooling).toContain('仍不合格 8 人')

    env.clock.now += 5 * HOUR
    await env.guard.runPatrol()
    expect(spyCards()).toHaveLength(8)
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】[IGC] 40001')
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(await env.guard.store.countAudit('cool-release', GROUP, new Date(0))).toBe(1)
    expect((await env.adminMessages()).join('\n')).toContain(`▶ 冷静期结束：${LABEL} 情况和 6 小时前一致，开始正常处置。`)
    expect([...(await env.guard.store.tracked(GROUP)).values()].every((r) => r.activeSince)).toBe(true)
  })

  it('AA 修好就立即恢复：冷静中的完整巡检发现已不超过阈值 → 结束；局部复查不结束', async () => {
    env = await setup()
    await massDeny('remind')
    env.clock.now += HOUR
    for (const qq of EIGHT) env.aa.allow(qq, `[IGC] ${qq}`) // AA 改回来了
    // 事件复查（局部）：仍在冷静中
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.events = EIGHT.map((qq, i) => ({ id: i + 1, kind: 'recheck', qq }))
    await env.guard.pollEvents()
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    // 完整巡检：立即结束
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain(`▶ 冷静期结束：${LABEL} 已恢复正常。`)
    expect(spyCards()).toEqual([])
    expect(await env.guard.store.tracked(GROUP)).toEqual(new Map())
  })

  it('冷静中：不合格的入群申请不拒绝，每日提醒不 @', async () => {
    env = await setup()
    addMembers('40009')
    await enableMode('remind') // 40009 已处置（加标记）
    expect(env.qq.member(GROUP, '40009')!.card).toBe('【SPY】名片40009')
    await massDeny('remind')
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    await requestEvent('40100', '')
    await settle()
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('这个群在冷静期，留给管理员处理')
    await env.guard.runReminders()
    expect(env.qq.groupMessages(GROUP)).toEqual([])
  })

  it('冷静满 6 小时后多了很多人 → 冷静期重新开始，仍不加标记', async () => {
    env = await setup()
    addMembers(...EIGHT)
    for (const qq of EIGHT) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('remind')
    for (const qq of EIGHT.slice(0, 3)) env.aa.deny(qq, 'NO_ACCESS')
    await env.guard.runPatrol() // 3 人 > 阈值 1
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    env.clock.now += 6 * HOUR
    for (const qq of EIGHT) env.aa.deny(qq, 'NO_ACCESS') // 又多了 5 人
    await env.guard.runPatrol()
    expect(spyCards()).toEqual([])
    const state = await env.guard.store.groupState(GROUP)
    expect(state.holdSince!.getTime()).toBe(env.clock.now)
    expect(JSON.parse(state.holdSet)).toHaveLength(8)
    expect((await env.adminMessages()).join('\n')).toContain(`⏸ 冷静期重新开始：${LABEL} 和冷静开始时相比多了 5 人`)
    expect(await env.guard.store.countAudit('cool-restart', GROUP, new Date(0))).toBe(1)
  })

  it('aaqq.confirm：提前结束等待，马上巡检；同一批人就继续，多了很多人就重新冷静', async () => {
    env = await setup()
    await massDeny('remind')
    ;(env.guard as any).patrolQueue = null // 机器人上线时排的那次全量巡检不算
    expect(await env.guard.confirm(GROUP, OPERATOR)).toContain(`已提前结束 ${LABEL} 的冷静等待，马上巡检`)
    expect(await env.guard.store.countAudit('cool-skip', GROUP, new Date(0))).toBe(1)
    expect([...(env.guard as any).patrolQueue]).toEqual([GROUP])
    await env.guard.runPatrol([GROUP])
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(spyCards()).toHaveLength(8)
  })

  it('aaqq.confirm 不跳过检查：变化很大时照样重新冷静', async () => {
    env = await setup()
    addMembers(...EIGHT)
    for (const qq of EIGHT) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('remind')
    for (const qq of EIGHT.slice(0, 2)) env.aa.deny(qq)
    await env.guard.runPatrol() // 2 人 → 冷静
    await env.guard.confirm(GROUP, OPERATOR)
    for (const qq of EIGHT) env.aa.deny(qq) // 之后又多了 6 人
    await env.guard.runPatrol([GROUP])
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect(spyCards()).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('冷静期重新开始')
  })

  it('冷静中把群改成 report：冷静状态清空，运维群「冷静期取消」', async () => {
    env = await setup()
    await massDeny('enforce')
    setMode('report')
    await env.guard.runPatrol()
    const state = await env.guard.store.groupState(GROUP)
    expect(state.holdSince).toBeNull()
    expect(state.holdSet).toBe('')
    expect((await env.adminMessages()).join('\n')).toContain(`ℹ ${LABEL} 改成了 report，冷静期取消。`)
    expect(await env.guard.store.countAudit('cool-clear', GROUP, new Date(0))).toBe(1)
  })

  it('0.1.x 留下的熔断（没有名单）：仍超过阈值 → 重新开始并记下名单；已正常 → 结束', async () => {
    for (const over of [true, false]) {
      env = await setup()
      addMembers(...EIGHT)
      if (!over) for (const qq of EIGHT) env.aa.allow(qq, `[IGC] ${qq}`)
      await env.app.database.upsert('aaqqbot_group', [{
        groupId: GROUP, confirmedMode: 'remind', holdSince: new Date(env.clock.now - 7 * HOUR), holdNote: '新增不合格 8 人',
        lastPatrolAt: new Date(env.clock.now - 7 * HOUR), lastPatrolOk: true, lastRosterSize: 11,
      }])
      setMode('remind')
      await env.guard.runPatrol()
      const state = await env.guard.store.groupState(GROUP)
      if (over) {
        expect(state.holdSince!.getTime()).toBe(env.clock.now)
        expect(JSON.parse(state.holdSet).sort()).toEqual(EIGHT)
        expect((await env.adminMessages()).join('\n')).toContain('升级前留下的熔断没有记下名单，现在记下这 8 人')
        expect(spyCards()).toEqual([])
      } else {
        expect(state.holdSince).toBeNull()
        expect((await env.adminMessages()).join('\n')).toContain('已恢复正常')
      }
      await env.stop()
    }
    env = await setup() // afterEach 要一个没停的环境
  })

  it('report 群里已知 3 个不合格（阈值 1），改成 remind：先冷静，满时间后才加标记（Q1）', async () => {
    env = await setup()
    addMembers('40001', '40002', '40003')
    await env.guard.runPatrol() // report：只记录
    setMode('remind')
    await env.guard.runPatrol()
    expect(spyCards()).toEqual([])
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('要开始处置的不合格成员有 3 人（超过阈值 1 人）')
    env.clock.now += 6 * HOUR
    await env.guard.runPatrol()
    expect(spyCards()).toHaveLength(3)
  })

  it('机器人是普通成员的 remind 群：全员不合格也不反复报冷静期', async () => {
    env = await setup()
    env.qq.member(GROUP, BOT)!.role = 'member'
    addMembers(...EIGHT)
    await enableMode('remind')
    for (let i = 0; i < 3; i++) {
      env.clock.now += 6 * HOUR
      await env.guard.runPatrol()
    }
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).not.toContain('冷静期开始')
    expect(messages).not.toContain('冷静期结束')
    expect(messages).toContain('· 机器人不是群主或管理员，本群不做任何改动')
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(env.qq.actions('set_group_card')).toEqual([])
  })

  it('端到端：两次冷静之前 0 移出，之后每小时不超过上限；群主、管理员、机器人从不被改名片、@ 或移出', async () => {
    env = await setup({ kickPerHour: 3 })
    const people = Array.from({ length: 10 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('enforce')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 40001')

    // AA 被改错：全员 NO_ACCESS → 第一次冷静
    for (const qq of people) env.aa.deny(qq, 'NO_ACCESS')
    await env.guard.runPatrol()
    expect(spyCards()).toEqual([])
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    expect(env.qq.actions('set_group_kick')).toEqual([])

    // 6 小时后还是这批人 → 结束冷静，加标记
    env.clock.now += 6 * HOUR
    await env.guard.runPatrol()
    expect(spyCards()).toHaveLength(10)

    // 每日提醒：定下截止时间（t + 48h），之后每天提醒
    const t = env.clock.now
    await env.guard.runReminders()
    expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats).sort()).toEqual(people)
    env.clock.now = t + 24 * HOUR
    await env.guard.runReminders()
    env.clock.now = t + 48 * HOUR
    await env.guard.runReminders()

    // 截止后第一次巡检：10 人同时到期 > 阈值 → 第二次冷静，0 移出
    env.clock.now = t + 49 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('一次有 10 人到期要移出（超过阈值 1 人）')

    // 再 6 小时：还是这批人 → 结束冷静，按每小时上限移出
    env.clock.now = t + 55 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(3)
    expect((await env.adminMessages()).at(-1)).toContain('7 人因每小时上限推迟到下一轮')
    // 同一小时内再巡检：这一小时累计移出仍不超过上限
    env.clock.now += 10 * 60_000
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(3)

    expect(await env.guard.store.countAudit('cool-start', GROUP, new Date(0))).toBe(2)
    expect(await env.guard.store.countAudit('cool-release', GROUP, new Date(0))).toBe(2)
    const untouchable = [OWNER, ADMIN, BOT]
    // 群主、管理员的名片只会被同步成 AA 给的（K1），从不加标记；机器人自己的不改
    const cards = env.qq.actions('set_group_card').filter((c) => untouchable.includes(String(c.params.user_id)))
    expect(cards.map((c) => [String(c.params.user_id), c.params.card]).sort()).toEqual([[OWNER, '[IGC] 群主'], [ADMIN, '[IGC] 管理员']].sort())
    expect(env.qq.actions('set_group_kick').filter((c) => untouchable.includes(String(c.params.user_id)))).toEqual([])
    expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats).filter((qq) => untouchable.includes(qq))).toEqual([])
  })
})

describe('入群申请', () => {
  it('带正确验证码：同意；入群后设名片（remind/enforce 模式）', async () => {
    env = await setup()
    await enableMode('remind')
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
    await enableMode('enforce')
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
    await enableMode('enforce')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
  })

  it('需要人工处理（review）：不同意也不拒绝', async () => {
    env = await setup()
    await enableMode('enforce')
    env.aa.review('40001')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
  })

  it('AA 连不上：不同意也不拒绝，报告管理员', async () => {
    env = await setup()
    await enableMode('enforce')
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
    await enableMode('remind')
    env.aa.allow('40001', '[IGC] 甲')
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', ''))
    await env.guard.handleNewMember(env.bot as any, GROUP, '40001')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 甲')
  })

  it('不合格（remind 模式）：加标记，并立即 @ 提醒', async () => {
    env = await setup()
    await enableMode('remind')
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
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(2)
    expect(env.aa.count('check')).toBe(0)
    expect((env.guard as any).patrolQueue).toBe('all')
  })

  it('recheck：只复查相关的人（不带 full_roster），按群合并成一次 check', async () => {
    env = await setup()
    addMembers('40001', '40002', '40003')
    for (const qq of ['40001', '40002', '40003']) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    await env.guard.store.setKv(env.guard.cursorKey, 0)
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
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(4)
  })

  it('事件复查也会进入冷静期：小群里一下子多人变成 deny', async () => {
    env = await setup()
    addMembers('40001', '40002', '40003')
    for (const qq of ['40001', '40002', '40003']) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    for (const qq of ['40001', '40002', '40003']) env.aa.deny(qq, 'NO_ACCESS')
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }, { id: 2, kind: 'recheck', qq: '40002' }, { id: 3, kind: 'recheck', qq: '40003' }]
    await env.guard.pollEvents()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('[IGC] 40001')
    const state = await env.guard.store.groupState(GROUP)
    expect(state.holdSince).not.toBeNull()
    expect(JSON.parse(state.holdSet).sort()).toEqual(['40001', '40002', '40003'])
    expect(await env.guard.store.countAudit('cool-start', GROUP, new Date(0))).toBe(1)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('⏸ 冷静期开始：联盟聊天群（111111111） 要开始处置的不合格成员有 3 人（超过阈值 1 人）')
    expect(messages).toContain('【AA 变化复查】')
  })

  it('复查时 AA 出错：游标不前进，下次重来', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }]
    env.aa.override('check', { status: 500, body: '{}' }, 1)
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(0)
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(1)
  })

  it('换了 AA 网址（测试 AA → 正式 AA）：游标重新开始，不沿用旧 AA 的进度', async () => {
    env = await setup()
    await env.guard.store.setKv(env.guard.cursorKey, 500)
    const oldKey = env.guard.cursorKey
    ;(env.guard as any).aa = new (env.guard.aa.constructor as any)(env.app, { baseUrl: `${env.aa.baseUrl}/`.replace('127.0.0.1', 'localhost'), keyId: env.config.keyId, secret: env.config.secret, timeoutMs: 5000 })
    expect(env.guard.cursorKey).not.toBe(oldKey)
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }, { id: 2, kind: 'recheck', qq: '40002' }]
    await env.guard.pollEvents()
    // 新 AA 第一次运行：从 0 开始拉完，只记游标，然后完整巡检
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(2)
    expect(await env.guard.store.getKv(oldKey)).toBe(500)
  })

  it('recheck_all：安排完整巡检；groups：重新拉取群列表', async () => {
    env = await setup()
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.groups.push({ group_id: OTHER_GROUP, name: '旗舰群', kind: 'role' })
    env.aa.events = [{ id: 1, kind: 'groups', qq: '' }, { id: 2, kind: 'recheck_all', qq: '' }]
    await env.guard.pollEvents()
    expect(env.guard.groups.map((g) => g.groupId)).toEqual([GROUP, OTHER_GROUP])
    expect((env.guard as any).patrolQueue).toBe('all')
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(2)
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
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders()
    await passDeadline()
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

describe('定时', () => {
  it('巡检结束后总会安排下一轮；巡检中又被要求巡检时，结束后马上再跑', async () => {
    env = await setup()
    await (env.guard as any).patrolTick()
    expect(env.guard.nextPatrolAt).toBe(env.clock.now + 6 * HOUR)
    env.aa.override('check', { status: 500, body: '{}', delayMs: 200 }, 1)
    const tick = (env.guard as any).patrolTick()
    await sleep(50)
    env.guard.requestPatrol()
    await tick
    expect(env.guard.nextPatrolAt).toBe(env.clock.now + 2000)
  })

  it('机器人不在线：1 分钟后再试', async () => {
    env = await setup()
    env.bot.offline()
    await (env.guard as any).patrolTick()
    expect(env.guard.nextPatrolAt).toBe(env.clock.now + 60_000)
  })
})

describe('通知', () => {
  it('发送通知失败不影响移出，也不影响记录', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders()
    await passDeadline()
    env.qq.failSendGroups.add(ADMIN_GROUP)
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

  it('白名单写错（带了名字）：启动时运维群警告一次，aaqq.status 里也有；写对的照常生效（0.2.3 R7）', async () => {
    env = await setup({ whitelist: ['12345678 张三', ' 40001 '] })
    addMembers('40001')
    await enableMode('remind')
    const messages = (await env.adminMessages()).join('\n')
    expect(messages.match(/白名单里有/g)).toHaveLength(1)
    expect(messages).toContain('⚠ 白名单里有 1 条写得不对，没有生效（每一条只能填一个 QQ 号）：\n· 12345678 张三')
    expect(await env.guard.statusText()).toContain('⚠ 白名单里有 1 条写得不对，没有生效（每一条只能填一个 QQ 号）：\n· 12345678 张三')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
  })

  it('白名单都写对了：不警告', async () => {
    env = await setup({ whitelist: ['40001'] })
    await env.guard.runPatrol()
    expect((await env.adminMessages()).join('\n')).not.toContain('白名单')
    expect(await env.guard.statusText()).not.toContain('白名单')
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
    expect((await env.say(OPERATOR, `aaqq.confirm ${GROUP}`)).join()).toContain('现在不在冷静期')
    expect((await env.say(OPERATOR, 'aaqq')).join()).toContain('提前结束冷静等待')
  })
})

describe('审查发现的问题（回归测试）', () => {
  it('冷静 3 天期间没有提醒：冷静结束后不会立刻移出，要重新提醒后才移出', async () => {
    env = await setup()
    const others = ['40002', '40003', '40004', '40005', '40006', '40007', '40008']
    addMembers('40001', ...others)
    for (const qq of others) env.aa.allow(qq, `[IGC] ${qq}`)
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders() // 40001 的截止时间定在 48 小时后
    for (const qq of others) env.aa.deny(qq, 'NO_ACCESS')
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    env.clock.now += 72 * HOUR
    const before = env.qq.groupMessages(GROUP).length
    await env.guard.runReminders() // 冷静中，不提醒
    expect(env.qq.groupMessages(GROUP).length).toBe(before)
    await env.guard.runPatrol() // 冷静满时间、还是那批人 → 结束；40001 的截止时间已过、但最近 36 小时没被提醒过
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()
    // 截止时间清空，重新提醒后再算完整的宽限期（DECISIONS 第 48 条）
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil).toBeNull()
    const released = (await env.adminMessages()).join('\n')
    expect(released).toContain('开始正常处置（1 人的截止时间已过期，重新提醒后再算宽限期）')
    expect(released).not.toContain('已恢复正常')
    await env.guard.runReminders()
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()
    // 新的截止时间到了：8 人同时到期 → 又冷静一次；再 6 小时还是这批人才移出
    await passDeadline()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()
    env.clock.now += 6 * HOUR
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
  })

  it('移出前再问一次 AA：刚好在这时绑定好了 → 不移出', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders()
    await passDeadline()
    env.aa.beforeResponse = (name, body) => {
      if (name === 'check' && body.full_roster === false && body.qqs.includes('40001')) env.aa.allow('40001', '[IGC] 张三')
    }
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()
    expect((await env.adminMessages()).at(-1)).toContain('复核后跳过 1 人')
  })

  it('白名单里的人申请入群、AA 判不合格：不拒绝，留给管理员', async () => {
    env = await setup({ whitelist: ['40001'] })
    await enableMode('enforce')
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('白名单')
  })

  it('补处理的申请和实时的一样处理：合格的同意，不合格的拒绝', async () => {
    env = await setup()
    await enableMode('enforce')
    env.aa.allow('40001', '[IGC] 甲')
    env.qq.systemMsg = {
      join_requests: [
        { request_id: 801, requester_uin: 40001, message: '', group_id: +GROUP, checked: false },
        { request_id: 802, requester_uin: 40002, message: '', group_id: +GROUP, checked: false },
      ],
    }
    await env.guard.catchUpRequests(env.bot as any)
    expect(env.qq.requests).toEqual([
      { flag: '801', approve: true, reason: '' },
      { flag: '802', approve: false, reason: expect.stringContaining('https://auth.example.com/services/') },
    ])
    expect((await env.adminMessages()).join('\n')).toContain('🚫 补处理的入群申请：已拒绝 40002 加入 联盟聊天群（111111111）')
  })

  it('补处理的申请，report 模式：不合格的不拒绝，留给管理员', async () => {
    env = await setup()
    env.qq.systemMsg = { join_requests: [{ request_id: 804, requester_uin: 40002, message: '', group_id: +GROUP, checked: false }] }
    await env.guard.catchUpRequests(env.bot as any)
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('群模式是 report，留给管理员处理')
  })

  it('AA 掉线时来的申请：AA 恢复连接后按规则补处理（该拒绝的拒绝）', async () => {
    env = await setup()
    await enableMode('enforce')
    env.aa.override('claim', { status: 502, body: 'Bad Gateway' }, 2) // 第一次和重试都失败
    await requestEvent('40002', '')
    await settle()
    await sleep(2200) // 等一次重试
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('AA 恢复后还没人处理的话，会按规则自动补处理')
    // 申请还挂在 QQ 里；AA 恢复
    env.qq.systemMsg = { join_requests: [{ request_id: 805, requester_uin: 40002, message: '', group_id: +GROUP, checked: false }] }
    await env.guard.checkHealth(false)
    await waitFor(() => env.qq.requests.length > 0)
    expect(env.qq.requests).toEqual([{ flag: '805', approve: false, reason: expect.stringContaining('https://auth.example.com/services/') }])
  })

  it('暂停时来的申请：解除暂停后按规则补处理', async () => {
    env = await setup()
    await enableMode('enforce')
    env.aa.allow('40001', '[IGC] 甲')
    await env.guard.setPaused(true, OPERATOR)
    await requestEvent('40001', '')
    await settle()
    expect(env.qq.requests).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('插件暂停中，留给管理员处理（恢复后还没人处理的话，会按规则自动补处理）')
    env.qq.systemMsg = { join_requests: [{ request_id: 806, requester_uin: 40001, message: '', group_id: +GROUP, checked: false }] }
    await env.guard.setPaused(false, OPERATOR)
    await waitFor(() => env.qq.requests.length > 0)
    expect(env.qq.requests).toEqual([{ flag: '806', approve: true, reason: '' }])
  })

  it('已经留给管理员的申请：AA 失联又恢复两次，只通知一次（0.2.3 R6）', async () => {
    env = await setup() // report 群：不合格的申请留给管理员
    await requestEvent('40002', '')
    await settle()
    env.qq.systemMsg = { join_requests: [{ request_id: 807, requester_uin: 40002, message: '', group_id: +GROUP, checked: false }] }
    for (let i = 0; i < 2; i++) {
      env.clock.now += 31 * 60_000 // 「刚处理过」的记忆已经过期
      env.aa.override('check', { status: 500, body: '{"ok":false}' })
      await env.guard.runPatrol()
      env.aa.overrides.clear()
      await env.guard.runPatrol()
      await sleep(300)
    }
    const messages = (await env.adminMessages()).join('\n')
    expect(messages.match(/AA 已恢复/g)).toHaveLength(2)
    expect(messages.match(/40002 申请加入/g)).toHaveLength(1)
    expect(env.aa.count('claim')).toBe(1)
  })

  it('补处理时，刚通过实时事件处理过的人不再重复处理', async () => {
    env = await setup()
    env.aa.allow('40001', '[IGC] 甲')
    await requestEvent('40001', '')
    await settle()
    env.qq.systemMsg = { join_requests: [{ request_id: 803, requester_uin: 40001, message: '', group_id: +GROUP, checked: false }] }
    await env.guard.catchUpRequests(env.bot as any)
    expect(env.aa.count('claim')).toBe(1)
  })

  it('群改成 off：撤掉标记、清空跟踪记录和名片记录', async () => {
    env = await setup()
    addMembers('40001')
    env.qq.member(GROUP, '40001')!.card = '张三'
    env.qq.failCard.add(ADMIN) // QQ 不让改管理员的名片 → 有一条名片记录
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】张三')
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(1)
    setMode('off')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('张三')
    expect((await env.guard.store.tracked(GROUP)).size).toBe(0)
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(0)
  })

  it('群从 AA 移除后再加回来：冷静状态、名片记录、跟踪记录都清空', async () => {
    env = await setup()
    const people = ['40001', '40002', '40003']
    addMembers(...people)
    await enableMode('remind') // 3 人 > 阈值 1 → 冷静期
    await env.guard.store.saveCardNote(GROUP, ADMIN, '[IGC] 管理员', 'refused')
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.guard.store.tracked(GROUP)).size).toBe(3)
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(1)
    const groups = env.aa.groups
    env.aa.groups = []
    await env.guard.refreshGroups()
    env.aa.groups = groups
    await env.guard.refreshGroups()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect((await env.guard.store.tracked(GROUP)).size).toBe(0)
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(0)
    expect(await env.guard.statusText()).not.toContain('冷静中')
  })

  it('身份认不出来的成员：不加标记', async () => {
    env = await setup()
    addMembers('40001')
    ;(env.qq.member(GROUP, '40001') as any).role = 'weird'
    await enableMode('remind')
    await env.guard.runPatrol([GROUP])
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
  })

  it('事件复查遇到确定性错误（例如 403）：跳过，不卡住游标', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }]
    env.aa.override('check', { status: 403, body: '<html>Forbidden</html>' }, 1)
    await env.guard.pollEvents()
    expect(await env.guard.store.getKv(env.guard.cursorKey)).toBe(1)
  })

  it('提醒没发出去：不定截止时间，也就不会被移出', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    env.qq.failSendGroups.add(GROUP)
    await env.guard.runReminders()
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil).toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('⚠ 联盟聊天群（111111111） 提醒没有发出去（1 人），没有记提醒时间，这些人不会因此被移出')
    env.clock.now += 100 * HOUR
    await env.guard.runReminders()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeDefined()
  })
})

describe('第二轮问题清单（回归测试）', () => {
  it('取群成员名单时强制 LLBot 刷新（no_cache）', async () => {
    env = await setup()
    await env.guard.runPatrol()
    const call = env.qq.actions('get_group_member_list')[0]
    expect(call.params).toMatchObject({ group_id: +GROUP, no_cache: true })
  })

  it('名单突然变少：不当作完整名单交给 AA，也不取消跟踪；下一轮名单稳定后恢复', async () => {
    env = await setup()
    const people = Array.from({ length: 20 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people.slice(1)) env.aa.allow(qq, `名片${qq}`)
    await enableMode('remind')
    await env.guard.runPatrol([GROUP]) // 40001 被跟踪
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(true)
    // LLBot 只返回了一部分人（40001 不在里面）
    const group = env.qq.groups.get(GROUP)!
    for (const qq of people.slice(0, 12)) group.delete(qq)
    await env.guard.runPatrol()
    expect(env.aa.last('check')!.body.full_roster).toBe(false)
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(true)
    expect((await env.adminMessages()).at(-1)).toContain('可能不完整')
    // 下一轮人数一样：按完整名单处理
    await env.guard.runPatrol()
    expect(env.aa.last('check')!.body.full_roster).toBe(true)
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(false)
  })

  it('启动步骤出错：定时任务照样安排好', async () => {
    env = await setup()
    ;(env.guard as any).options.timers = true
    env.guard.checkHealth = async () => { throw new Error('boom') }
    env.guard.nextPatrolAt = null
    await env.guard.start()
    expect(env.guard.nextPatrolAt).not.toBeNull()
  })

  it('启动时读不到暂停状态：为安全起见先暂停', async () => {
    env = await setup()
    const original = env.guard.store.getKv.bind(env.guard.store)
    env.guard.store.getKv = (async (key: string) => {
      if (key === 'paused') throw new Error('db down')
      return original(key)
    }) as any
    await env.guard.start()
    expect(env.guard.paused).toBe(true)
  })

  it('一轮巡检时间到了：停在两个群之间，剩下的群马上接着巡检', async () => {
    env = await setup()
    env.aa.groups.push({ group_id: OTHER_GROUP, name: '旗舰群', kind: 'role' })
    env.qq.addGroup(OTHER_GROUP, [{ user_id: +BOT, role: 'admin', card: '机器人', nickname: 'bot' }])
    await env.guard.refreshGroups()
    ;(env.guard as any).options.patrolSoftBudgetMs = 0
    ;(env.guard as any).patrolQueue = null // 机器人上线时排的那次全量巡检不算
    await env.guard.runPatrol()
    expect([...(env.guard as any).patrolQueue]).toEqual([OTHER_GROUP])
    expect((await env.adminMessages()).at(-1)).toContain('马上接着巡检')
  })
})

describe('群主、管理员的名片（K1）', () => {
  const HEADER = '群主/管理员的名片机器人改不了（请自己改成箭头后面的样子）'
  const cardCalls = (qq: string) => env.qq.actions('set_group_card').filter((c) => String(c.params.user_id) === qq)
  const last = async () => (await env.adminMessages()).at(-1)!

  /** 机器人设为群主，原来的群主改成管理员（群主只有一个）。 */
  function botIsOwner() {
    env.qq.member(GROUP, BOT)!.role = 'owner'
    env.qq.member(GROUP, OWNER)!.role = 'admin'
  }

  it('机器人是群主：管理员的名片改成 AA 的', async () => {
    env = await setup()
    botIsOwner()
    await enableMode('remind')
    expect(env.qq.member(GROUP, OWNER)!.card).toBe('[IGC] 群主')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
    const report = await last()
    expect(report).toContain('· 同步名片 2 人（其中群主/管理员 2 人）')
    expect(report).not.toContain(HEADER)
  })

  it('机器人只是管理员：群主和其他管理员的名片也改成 AA 的（所有者实测）', async () => {
    env = await setup()
    await enableMode('remind')
    expect(env.qq.member(GROUP, OWNER)!.card).toBe('[IGC] 群主')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
    const report = await last()
    expect(report).toContain('· 同步名片 2 人（其中群主/管理员 2 人）')
    expect(report).not.toContain(HEADER)
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(0)
  })

  for (const botRole of ['admin', 'owner'] as const) {
    it(`QQ 拒绝（机器人是${botRole === 'owner' ? '群主' : '管理员'}）：列一次，同一张名片不再重试；AA 名片变了再试一次`, async () => {
      env = await setup()
      if (botRole === 'owner') botIsOwner()
      env.qq.failCard.add(ADMIN)
      await enableMode('remind')
      expect(cardCalls(ADMIN)).toHaveLength(1)
      expect(await last()).toContain(`${HEADER}1 人\n· 管理员(10002) → [IGC] 管理员`)
      expect((await env.guard.store.cardNotes(GROUP)).get(ADMIN)).toMatchObject({ card: '[IGC] 管理员', why: 'refused' })
      expect(await env.guard.store.countAudit('admin-card', GROUP, new Date(0))).toBe(1)
      await env.guard.runPatrol()
      expect(cardCalls(ADMIN)).toHaveLength(1)
      expect(await last()).not.toContain(HEADER)
      env.aa.allow(ADMIN, '[IGC] 管理员 - 新')
      await env.guard.runPatrol()
      expect(cardCalls(ADMIN)).toHaveLength(2)
      expect(await last()).toContain('· 管理员(10002) → [IGC] 管理员 - 新')
    })
  }

  it('给群主加标记被 QQ 拒绝（0.2.3 R4）：列一次，不再重试，记录里也不算「已加标记」；普通成员照常', async () => {
    env = await setup({ breakerCount: 100, breakerPercent: 100 })
    addMembers('40001')
    env.aa.deny(OWNER)
    env.qq.failCard.add(OWNER)
    await enableMode('remind')
    expect(cardCalls(OWNER)).toHaveLength(1)
    expect(await last()).toContain(`${HEADER}1 人\n· 群主(10001) → 【SPY】群主`)
    expect((await env.guard.store.tracked(GROUP)).get(OWNER)!.marked).toBe(false)
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    await env.guard.runReminders()
    await env.guard.runPatrol()
    const report = await last()
    expect(report).not.toContain(HEADER)
    expect(report).not.toContain('改名片失败')
    expect(cardCalls(OWNER)).toHaveLength(1)
    expect((await env.guard.store.tracked(GROUP)).get(OWNER)!.marked).toBe(false)
    expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats).sort()).toEqual(['10001', '40001'])
    // 群主自己改好了：认出来，不再列
    env.qq.member(GROUP, OWNER)!.card = '【SPY】群主'
    await env.guard.runPatrol()
    expect((await env.guard.store.tracked(GROUP)).get(OWNER)!.marked).toBe(true)
    expect(cardCalls(OWNER)).toHaveLength(1)
  })

  it('改名片超时：不列、不记；超时解除后下一轮改成功', async () => {
    env = await setup()
    env.qq.timeoutActions.add('set_group_card')
    await enableMode('remind')
    expect(await last()).not.toContain(HEADER)
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(0)
    env.qq.timeoutActions.clear()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
  })

  it('QQ 拒绝后管理员自己改好名片：记录保留；再改乱（AA 名片没变）不再报、不重试；AA 名片变了再报', async () => {
    env = await setup()
    env.qq.failCard.add(ADMIN)
    await enableMode('remind')
    expect(await last()).toContain('· 管理员(10002) → [IGC] 管理员')
    env.qq.member(GROUP, ADMIN)!.card = '[IGC] 管理员'
    await env.guard.runPatrol()
    expect((await env.guard.store.cardNotes(GROUP)).has(ADMIN)).toBe(true)
    env.qq.member(GROUP, ADMIN)!.card = '乱改的'
    await env.guard.runPatrol()
    expect(await last()).not.toContain('管理员(10002) →')
    expect(cardCalls(ADMIN)).toHaveLength(1)
    env.aa.allow(ADMIN, '[IGC] 管理员 - 新')
    await env.guard.runPatrol()
    expect(await last()).toContain('· 乱改的(10002) → [IGC] 管理员 - 新')
  })

  it('AA 给机器人自己一个名片：机器人的名片不变，也不列', async () => {
    env = await setup()
    botIsOwner()
    env.aa.allow(BOT, '[IGC] 机器人')
    await enableMode('remind')
    expect(cardCalls(BOT)).toEqual([])
    expect(env.qq.member(GROUP, BOT)!.card).toBe('机器人')
    expect(await last()).not.toContain('(12345) →')
  })

  it('事件复查路径：管理员在 AA 变成合格 → remind 群直接改好名片', async () => {
    env = await setup()
    env.aa.deny(ADMIN)
    await enableMode('remind')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.allow(ADMIN, '[IGC] 管理员')
    env.aa.events = [{ id: 1, kind: 'card', qq: ADMIN }]
    await env.guard.pollEvents()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
    expect(await last()).toContain('【AA 变化复查】')
  })

  it('事件复查路径：QQ 拒绝时【AA 变化复查】里列出；下一次巡检不重复、不重试', async () => {
    env = await setup({ markAdmins: false }) // 管理员一开始不合格时不加标记，只看名片同步
    env.aa.deny(ADMIN)
    env.qq.failCard.add(ADMIN)
    await enableMode('remind')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.allow(ADMIN, '[IGC] 管理员')
    env.aa.events = [{ id: 1, kind: 'card', qq: ADMIN }]
    await env.guard.pollEvents()
    const recheck = await last()
    expect(recheck).toContain('【AA 变化复查】')
    expect(recheck).toContain(`${HEADER}1 人\n· 管理员(10002) → [IGC] 管理员`)
    await env.guard.runPatrol()
    expect(await last()).not.toContain('管理员(10002) →')
    expect(cardCalls(ADMIN)).toHaveLength(1)
  })

  it('report 群：管理员名片只计入「名片不一致」，不改也不列', async () => {
    env = await setup()
    await env.guard.runPatrol()
    const report = await last()
    expect(report).toContain('· 2 人的名片与 AA 不一致（report 模式不修改）')
    expect(report).not.toContain(HEADER)
    expect(env.qq.actions('set_group_card')).toEqual([])
  })

  it('0.2.0 留下的「身份不够」记录：0.2.1 会重新试一次，改成功就删掉记录、不再列', async () => {
    env = await setup()
    await env.guard.store.saveCardNote(GROUP, OWNER, '[IGC] 群主', 'role')
    await env.guard.store.saveCardNote(GROUP, ADMIN, '[IGC] 管理员', 'role')
    await enableMode('remind')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
    expect(env.qq.member(GROUP, OWNER)!.card).toBe('[IGC] 群主')
    expect((await env.guard.store.cardNotes(GROUP)).size).toBe(0)
    expect(await last()).not.toContain(HEADER)
  })

  it('名单可疑（被截断）的那一轮不删名片记录：下一轮名单完整时不重复报', async () => {
    env = await setup()
    const people = Array.from({ length: 20 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `名片${qq}`)
    env.qq.failCard.add(ADMIN)
    await enableMode('remind')
    expect(await last()).toContain('· 管理员(10002) → [IGC] 管理员')
    // LLBot 只返回了一部分人（管理员不在里面）
    const group = env.qq.groups.get(GROUP)!
    const saved = new Map(group)
    for (const qq of [...people.slice(0, 12), ADMIN]) group.delete(qq)
    await env.guard.runPatrol()
    expect(await last()).toContain('可能不完整')
    expect((await env.guard.store.cardNotes(GROUP)).has(ADMIN)).toBe(true)
    env.qq.groups.set(GROUP, saved)
    await env.guard.runPatrol()
    expect(await last()).not.toContain('管理员(10002) →')
    expect(cardCalls(ADMIN)).toHaveLength(1)
  })
})

describe('report 模式记住报过谁；撤标记成功后才落库（K4）', () => {
  const last = async () => (await env.adminMessages()).at(-1)!
  const tracked = async (qq: string) => (await env.guard.store.tracked(GROUP)).get(qq)

  /** 给这些人直接加上标记和跟踪记录（相当于以前在 remind 下处置过）。 */
  async function markedPeople(qqs: string[]) {
    const group = env.qq.groups.get(GROUP)!
    for (const qq of qqs) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    await env.guard.store.saveTracked(qqs.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(env.clock.now - 72 * HOUR), graceUntil: null, marked: true,
      lastRemindedAt: null, activeSince: new Date(env.clock.now - 72 * HOUR),
    })))
  }

  it('report 连续两次巡检：第二次没有「新发现」，只有「仍不合格」；群里没有任何 @ 或改名片', async () => {
    env = await setup()
    addMembers('40001', '40002')
    await env.guard.runPatrol()
    const first = await last()
    expect(first).toContain('新发现不合格 2 人')
    await env.guard.runPatrol()
    const second = await last()
    expect(second).not.toContain('新发现')
    expect(second).toContain('仍不合格 2 人')
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    expect(env.qq.actions('set_group_card')).toEqual([])
    expect(await tracked('40001')).toMatchObject({ activeSince: null, marked: false, graceUntil: null })
  })

  it('report → remind（人数不超过阈值）：下一轮加标记，activeSince 有值', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    expect((await tracked('40001'))!.activeSince).toBeNull()
    await enableMode('remind')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect((await tracked('40001'))!.activeSince).not.toBeNull()
  })

  it('只记录的人（report 时记下、冷静中记下）：每日提醒不 @', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol() // report：只记录
    setMode('remind')
    await env.guard.runReminders() // 升级后、下一轮巡检之前的提醒
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    await env.guard.runPatrol()
    await env.guard.runReminders()
    expect(env.qq.groupMessages(GROUP).flatMap((m) => m.ats)).toEqual(['40001'])
  })

  it('撤标记失败：记录的 marked 仍为 true，下一轮再撤成功', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('remind')
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    env.qq.failCard.add('40001')
    setMode('report')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect((await tracked('40001'))!.marked).toBe(true)
    env.qq.failCard.clear()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    expect((await tracked('40001'))!.marked).toBe(false)
  })

  it('事件复查在 report 群里发现新的不合格：【AA 变化复查】里报一次，下一次巡检算「仍不合格」', async () => {
    env = await setup()
    addMembers('40001')
    env.aa.allow('40001', '名片40001')
    await env.guard.runPatrol()
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.deny('40001')
    env.aa.events = [{ id: 1, kind: 'recheck', qq: '40001' }]
    await env.guard.pollEvents()
    const recheck = await last()
    expect(recheck).toContain('【AA 变化复查】')
    expect(recheck).toContain('新发现不合格 1 人')
    await env.guard.runPatrol()
    const patrol = await last()
    expect(patrol).not.toContain('新发现')
    expect(patrol).toContain('仍不合格 1 人')
  })

  it('冷静中（已有标记的人）把群改成 report：先清冷静状态，再把标记全部撤掉；记录保留', async () => {
    env = await setup()
    const people = ['40001', '40002', '40003']
    await markedPeople(people)
    await env.guard.store.setGroupState(GROUP, { holdSince: new Date(env.clock.now), holdNote: '一次有 3 人到期要移出', holdSet: JSON.stringify(people) })
    setMode('report')
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    for (const qq of people) {
      expect(env.qq.member(GROUP, qq)!.card).toBe(`名片${qq}`)
      expect(await tracked(qq)).toMatchObject({ marked: false, activeSince: null })
    }
  })

  it('超过 100 个带标记的人时降到 report：第一轮撤 100 张，其余下一轮撤完', async () => {
    env = await setup()
    const people = Array.from({ length: 105 }, (_, i) => String(40001 + i))
    await markedPeople(people)
    setMode('report')
    await env.guard.runPatrol()
    const rows = [...(await env.guard.store.tracked(GROUP)).values()]
    expect(rows.filter((r) => r.marked)).toHaveLength(5)
    expect(env.qq.actions('set_group_card')).toHaveLength(100)
    expect(await last()).toContain('· 5 张名片留到下一轮再改')
    await env.guard.runPatrol()
    expect([...(await env.guard.store.tracked(GROUP)).values()].filter((r) => r.marked)).toEqual([])
    expect(people.every((qq) => env.qq.member(GROUP, qq)!.card === `名片${qq}`)).toBe(true)
  })

  it('撤标记途中暂停：没撤的记录仍 marked = true；恢复后下一轮继续撤', async () => {
    env = await setup()
    const people = ['40001', '40002', '40003', '40004', '40005']
    await markedPeople(people)
    let calls = 0
    env.qq.beforeCard = () => {
      if (++calls === 2) void env.guard.setPaused(true, OPERATOR)
    }
    setMode('report')
    await env.guard.runPatrol()
    const rows = [...(await env.guard.store.tracked(GROUP)).values()]
    expect(rows).toHaveLength(5)
    expect(rows.filter((r) => r.marked)).toHaveLength(3)
    env.qq.beforeCard = null
    await env.guard.setPaused(false, OPERATOR)
    await env.guard.runPatrol()
    expect([...(await env.guard.store.tracked(GROUP)).values()].filter((r) => r.marked)).toEqual([])
    expect(people.every((qq) => env.qq.member(GROUP, qq)!.card === `名片${qq}`)).toBe(true)
  })

  it('改成 off 途中暂停：没撤掉标记的人记录不删，下一轮继续撤，撤成功的才删', async () => {
    env = await setup()
    const people = ['40001', '40002', '40003', '40004', '40005']
    await markedPeople(people)
    let calls = 0
    env.qq.beforeCard = () => {
      if (++calls === 2) void env.guard.setPaused(true, OPERATOR)
    }
    setMode('off')
    await env.guard.runPatrol()
    expect((await env.guard.store.tracked(GROUP)).size).toBe(3)
    env.qq.beforeCard = null
    await env.guard.setPaused(false, OPERATOR)
    await env.guard.runPatrol()
    expect((await env.guard.store.tracked(GROUP)).size).toBe(0)
    expect(people.every((qq) => env.qq.member(GROUP, qq)!.card === `名片${qq}`)).toBe(true)
  })

  it('aaqq.status：已记录不合格 N 人（其中已处置 M 人）', async () => {
    env = await setup({ breakerPercent: 100 }) // 阈值 5：升级时两个人一起开始处置不进冷静期
    addMembers('40001')
    await markedPeople(['40002'])
    await env.guard.runPatrol()
    expect(await env.guard.statusText()).toContain('已记录不合格 2 人（其中已处置 0 人）')
    await enableMode('remind')
    expect(await env.guard.statusText()).toContain('已记录不合格 2 人（其中已处置 2 人）')
  })
})

describe('报告排版与名字（K5–K8）', () => {
  const last = async () => (await env.adminMessages()).at(-1)!

  it('按原因归组：同一原因的 3 人，原因只写一次；本轮动作每项一行', async () => {
    env = await setup({ breakerPercent: 100 })
    addMembers('40001', '40002', '40003')
    await enableMode('remind')
    const report = await last()
    expect(report.match(/【没有在 AA 绑定 QQ】/g)).toHaveLength(1)
    expect(report).toContain('新发现不合格 3 人\n【没有在 AA 绑定 QQ】\n· 名片40001(40001)\n· 名片40002(40002)\n· 名片40003(40003)')
    expect(report).toContain('本轮动作\n· 同步名片 2 人（其中群主/管理员 2 人）\n· 加标记 3 人')
  })

  it('一个分类最多列 15 人，其余写「另外 N 人」', async () => {
    env = await setup()
    addMembers(...Array.from({ length: 20 }, (_, i) => String(40001 + i)))
    await env.guard.runPatrol()
    const report = await last()
    expect(report).toContain('新发现不合格 20 人')
    expect(report).toContain('· 名片40015(40015)\n· ……另外 5 人')
    expect(report).not.toContain('(40016)')
  })

  it('统计不含机器人自己，机器人没绑定也不列出（K6）', async () => {
    env = await setup()
    addMembers('40001')
    await env.guard.runPatrol()
    const report = await last()
    expect(report).toContain('成员 3（不含机器人）')
    expect(report).not.toContain('(12345)')
  })

  it('名片是空白或看不见的字符：显示昵称（K7）', async () => {
    env = await setup()
    const blank = `${String.fromCodePoint(0x200b)} ${String.fromCodePoint(0x3164)}`
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', blank, '小明'))
    await env.guard.runPatrol()
    expect(await last()).toContain('· 小明(40001)')
    setMode('remind')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】小明')
  })

  it('报告里的名字去掉【SPY】（K8）', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('remind')
    await env.adminMessages()
    await env.guard.runPatrol()
    const report = await last()
    expect(report).toContain('仍不合格 1 人\n【没有在 AA 绑定 QQ】\n· 名片40001(40001)')
    expect(report).not.toContain('【SPY】')
  })
})

describe('LLBot 超时（K9）', () => {
  it('取群成员名单超时：说成「LLBot 响应超时」，不说「机器人可能不在这个群里」', async () => {
    env = await setup()
    env.qq.timeoutActions.add('get_group_member_list')
    await env.guard.runPatrol()
    const report = (await env.adminMessages()).join('\n')
    expect(report).toContain('❌ 取群成员名单失败：LLBot 响应超时，检查 adapter-onebot 的 responseTimeout（建议 60000 毫秒）')
    expect(report).not.toContain('机器人可能不在这个群里')
  })

  it('responseTimeout 太小：提醒一次（不重复）；aaqq.health 显示当前值', async () => {
    env = await setup()
    const config = (env.bot as any).config
    config.protocol = 'ws'
    config.responseTimeout = 600
    env.guard.checkOneBotConfig(env.bot as any)
    env.guard.checkOneBotConfig(env.bot as any)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages.match(/responseTimeout」只有 600 毫秒/g)).toHaveLength(1)
    expect(messages).toContain('改成 60000')
    expect(await env.guard.checkHealth(false)).toContain('adapter-onebot 的 responseTimeout：600 毫秒（⚠ 太小，请改成 60000）')
  })

  it('responseTimeout 是 60000：不提醒', async () => {
    env = await setup()
    const config = (env.bot as any).config
    config.protocol = 'ws'
    config.responseTimeout = 60000
    env.guard.checkOneBotConfig(env.bot as any)
    expect((await env.adminMessages()).join('\n')).not.toContain('responseTimeout')
    expect(await env.guard.checkHealth(false)).toContain('adapter-onebot 的 responseTimeout：60000 毫秒')
  })
})

describe('移出超时但其实成功了（0.2.3 R2）', () => {
  const first = ['40001', '40002', '40003', '40004', '40005']
  const second = ['40006', '40007', '40008', '40009', '40010']

  /** 10 个带标记的人：前 5 个已到期，后 5 个 20 分钟后到期；踢人时 LLBot 执行了但响应超时。 */
  async function timeoutKicks(config: Record<string, unknown>, allowed = 0) {
    env = await setup({ breakerPercent: 100, kickPerHour: 6, ...config })
    const group = env.qq.groups.get(GROUP)!
    for (const qq of [...first, ...second]) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    for (let i = 0; i < allowed; i++) {
      const qq = String(50001 + i)
      group.set(qq, plainMember(qq, `[IGC] ${qq}`))
      env.aa.allow(qq, `[IGC] ${qq}`)
    }
    const now = env.clock.now
    await env.guard.store.saveTracked([...first, ...second].map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(now - 72 * HOUR), marked: true,
      activeSince: new Date(now - 72 * HOUR), lastRemindedAt: new Date(now - HOUR),
      graceUntil: new Date(first.includes(qq) ? now - 60_000 : now + 20 * 60_000),
    })))
    const original = env.qq.handle.bind(env.qq)
    env.qq.handle = (action, params) => {
      const result = original(action, params)
      if (action === 'set_group_kick') throw new OneBot.TimeoutError(params, action)
      return result
    }
    setMode('enforce')
    await env.guard.runPatrol()
  }

  it('超时后查不到他在群里：记操作记录、删跟踪记录、汇报里算移出', async () => {
    await timeoutKicks({})
    expect(env.qq.actions('set_group_kick')).toHaveLength(5)
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(5)
    const rows = await env.guard.store.tracked(GROUP)
    expect(first.some((qq) => rows.has(qq))).toBe(false)
    const report = (await env.adminMessages()).join('\n')
    expect(report).toContain('移出 5 人')
    expect(report).not.toContain('移出失败')
  })

  it('计入熔断窗口：半小时后又到期 5 人 → 进入冷静期、0 移出', async () => {
    await timeoutKicks({})
    env.clock.now += 30 * 60_000
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(5)
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('最近 6 小时内到期要移出的有 10 人（这一轮 5 人、已经移出 5 人，超过阈值 5 人）')
  })

  it('计入每小时上限：上限 6，半小时后只再移出 1 人', async () => {
    await timeoutKicks({ breakerCount: 100 }, 20) // 群够大，熔断不会先挡住
    env.clock.now += 30 * 60_000
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(6)
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(6)
  })

  it('超时后他还在群里：不算移出，下一轮再处理', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runPatrol([GROUP])
    await env.guard.runReminders()
    await passDeadline()
    env.qq.timeoutActions.add('set_group_kick')
    await env.guard.runPatrol()
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(0)
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(true)
    env.qq.timeoutActions.clear()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(1)
  })
})

describe('刚启动、还没巡检过这个群时有新人入群（0.2.3 R3）', () => {
  const marked = (qq: string) => env.qq.member(GROUP, qq)!.card.startsWith('【SPY】')

  /** 阈值 5 的 remind 群：12 个合格成员，其中 processed 个刚被处置；然后清掉名单缓存（相当于刚重启）。 */
  async function restartedGroup(processed: number) {
    env = await setup({ breakerPercent: 100 })
    const people = Array.from({ length: 12 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `名片${qq}`)
    await enableMode('remind')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    people.slice(0, processed).forEach((qq, i) => {
      env.aa.deny(qq, 'NOT_BOUND')
      env.aa.events.push({ id: i + 1, kind: 'recheck', qq })
    })
    await env.guard.pollEvents()
    expect(people.slice(0, processed).every(marked)).toBe(true)
    env.guard.rosters.clear()
    env.qq.groups.get(GROUP)!.set('50001', plainMember('50001', '新人'))
  }

  it('按真实人数算阈值：最近处置过 3 人，再来 1 个不合格的新人 → 不进入冷静期，照常提醒', async () => {
    await restartedGroup(3)
    await env.guard.handleNewMember(env.bot as any, GROUP, '50001')
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(marked('50001')).toBe(true)
    expect(env.qq.groupMessages(GROUP).at(-1)!.ats).toEqual(['50001'])
    expect((await env.adminMessages()).join('\n')).not.toContain('冷静期开始')
  })

  it('真的超过阈值：最近处置过 5 人，再来 1 个 → 进入冷静期，新人只记录', async () => {
    await restartedGroup(5)
    await env.guard.handleNewMember(env.bot as any, GROUP, '50001')
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect(marked('50001')).toBe(false)
    expect((await env.adminMessages()).join('\n')).toContain('⏸ 冷静期开始：联盟聊天群（111111111） 最近 6 小时内要开始处置的不合格成员有 6 人（这一轮 1 人、之前 5 人，超过阈值 5 人）')
  })

  it('取不到群人数：不据此进入冷静期，新人这一轮只记录', async () => {
    await restartedGroup(5)
    env.qq.timeoutActions.add('get_group_member_list')
    await env.guard.handleNewMember(env.bot as any, GROUP, '50001')
    env.qq.timeoutActions.clear()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(marked('50001')).toBe(false)
    expect((await env.guard.store.tracked(GROUP)).has('50001')).toBe(true)
  })
})

describe('机器人自己一轮移出很多人（0.2.3 R5）', () => {
  it('21 人的群一轮移出 7 人：下一轮不报「名单可能不完整」，照常交完整名单', async () => {
    env = await setup({ breakerCount: 100, breakerPercent: 100 })
    const leaving = Array.from({ length: 7 }, (_, i) => String(40001 + i))
    const staying = Array.from({ length: 11 }, (_, i) => String(50001 + i))
    const group = env.qq.groups.get(GROUP)!
    for (const qq of leaving) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    for (const qq of staying) {
      group.set(qq, plainMember(qq, `[IGC] ${qq}`))
      env.aa.allow(qq, `[IGC] ${qq}`)
    }
    const now = env.clock.now
    await env.guard.store.saveTracked(leaving.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(now - 72 * HOUR), marked: true,
      activeSince: new Date(now - 72 * HOUR), lastRemindedAt: new Date(now - HOUR), graceUntil: new Date(now - 60_000),
    })))
    await env.app.database.upsert('aaqqbot_group', [{ groupId: GROUP, lastRosterSize: 21 }])
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(7)
    expect((await env.guard.store.groupState(GROUP)).lastRosterSize).toBe(14)
    env.clock.now += HOUR
    await env.guard.runPatrol()
    expect((await env.adminMessages()).join('\n')).not.toContain('可能不完整')
    expect(env.aa.last('check')!.body.full_roster).toBe(true)
    expect((await env.guard.store.groupState(GROUP)).lastRosterSize).toBe(14)
  })
})

describe('每日提醒留痕（K10）', () => {
  it('提醒后：操作记录、运维群回执', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('remind')
    await env.guard.runReminders()
    expect(await env.guard.store.countAudit('remind', GROUP, new Date(0))).toBe(1)
    expect((await env.adminMessages()).join('\n')).toContain('⏰ 联盟聊天群（111111111） 已提醒 1 人')
  })

  it('新人入群的即时提醒：有操作记录，但不发 ⏰', async () => {
    env = await setup()
    await enableMode('remind')
    env.qq.groups.get(GROUP)!.set('40001', plainMember('40001', '新人'))
    await env.guard.handleNewMember(env.bot as any, GROUP, '40001')
    expect(await env.guard.store.countAudit('remind', GROUP, new Date(0))).toBe(1)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('👋')
    expect(messages).not.toContain('⏰')
  })

  it('已经过了截止时间还没被移出的人：每日提醒说「已过截止时间，下一次处理时会被移出」（0.2.3 R8）', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runReminders()
    expect(env.qq.groupMessages(GROUP).at(-1)!.text).toMatch(/（没有在 AA 绑定 QQ，截止 \d/)
    await passDeadline() // 截止时间过了，这期间没有巡检
    const text = env.qq.groupMessages(GROUP).at(-1)!.text
    expect(text).toContain('（没有在 AA 绑定 QQ，已过截止时间，下一次处理时会被移出）')
    expect(text).not.toMatch(/截止 \d/)
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
  })

  it('提醒超时：回执里说「群里可能其实已经看到了」', async () => {
    env = await setup()
    addMembers('40001')
    await enableMode('remind')
    env.qq.timeoutActions.add('send_group_msg')
    await env.guard.runReminders()
    env.qq.timeoutActions.clear()
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('提醒没有发出去（1 人），没有记提醒时间，这些人不会因此被移出；LLBot 响应超时，群里可能其实已经看到了')
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.lastRemindedAt).toBeNull()
  })
})

describe('通知失败不重发（K11）', () => {
  const adminSends = () => env.qq.actions('send_group_msg').filter((c) => String(c.params.group_id) === ADMIN_GROUP)

  it('发往运维群失败：只发一次', async () => {
    env = await setup()
    env.qq.failSendGroups.add(ADMIN_GROUP)
    env.guard.notifier.push('测试通知')
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(1)
  })

  it('发往运维群超时：只发一次', async () => {
    env = await setup()
    env.qq.timeoutActions.add('send_group_msg')
    env.guard.notifier.push('测试通知')
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(1)
  })
})

describe('运维通知被 QQ 拒收：主动分短 + 拆小重发（0.2.4 M1）', () => {
  const HIDDEN = '（名字含 QQ 不允许的内容，已隐藏）'
  const adminSends = () => env.qq.actions('send_group_msg').filter((c) => String(c.params.group_id) === ADMIN_GROUP)
  const delivered = () => env.qq.groupMessages(ADMIN_GROUP).map((m) => m.text)
  const names = (text: string) => text.match(/\(\d{5,12}\)/g) ?? []
  const listLines = (text: string) => text.split('\n').filter((line) => /\(\d{5,12}\)/.test(line)).length

  /** 仿照正式环境的巡检报告：4 个群，每群 20 人。 */
  function report(badName = '') {
    let qq = 40000
    const sections = Array.from({ length: 4 }, (_, g) => [
      `▶ 第${g + 1}群（${100000000 + g}）　enforce（提醒并移出）`,
      '仍不合格 20 人',
      '【没有在 AA 绑定 QQ】',
      ...Array.from({ length: 20 }, () => {
        qq++
        return `· ${badName && qq === 40025 ? badName : `名字${qq}`}(${qq})`
      }),
    ].join('\n'))
    return ['【AA 巡检】09-29 03:50 完成，用时 12 秒', ...sections].join('\n\n')
  }

  it('没有被拒时：名单每条最多 20 行，一次发完', async () => {
    env = await setup()
    const text = report()
    env.guard.notifier.push(text)
    const messages = await env.adminMessages()
    expect(messages.length).toBeGreaterThanOrEqual(4)
    for (const m of messages) expect(listLines(m)).toBeLessThanOrEqual(20)
    expect(messages.flatMap(names)).toEqual(names(text))
    expect(adminSends()).toHaveLength(messages.length)
  })

  it('QQ 拒收超过 10 行名单的消息：对半拆开重发，名单全部送达，没有名字被隐藏', async () => {
    env = await setup()
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && listLines(text) > 10
    const text = report()
    env.guard.notifier.push(text)
    const messages = await env.adminMessages()
    expect(messages.flatMap(names)).toEqual(names(text))
    expect(messages.join('\n')).not.toContain(HIDDEN)
    expect(messages.length).toBeGreaterThan(4)
    expect(messages.some((m) => /^（\d+\/4-1）/.test(m))).toBe(true) // 例如（3/4-1）
    expect(messages.some((m) => /^（\d+\/4-2-2）/.test(m))).toBe(true) // 拆开后还被拒的再拆：（3/4-2-2）
    for (const m of messages) expect(listLines(m)).toBeLessThanOrEqual(10)
  })

  it('某个名字单独一行也被拒：只有这一行的名字被隐藏，其他照常送达', async () => {
    env = await setup()
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && text.includes('坏词')
    const text = report('坏词张三')
    env.guard.notifier.push(text)
    const messages = await env.adminMessages()
    const all = messages.join('\n')
    expect(all).not.toContain('坏词')
    expect(all).toContain(`· ${HIDDEN}(40025)`)
    expect(all.split(HIDDEN)).toHaveLength(2) // 只隐藏了一行
    // 隐藏后重发的那条仍带序号，例如（2/4-1-2-1-1-2）
    expect(messages.some((m) => new RegExp(`^（2/4(-\\d+)+）· ${HIDDEN}\\(40025\\)$`).test(m))).toBe(true)
    expect(messages.flatMap(names)).toEqual(names(text))
  })

  it('LLBot 响应超时：不拆、不重发', async () => {
    env = await setup()
    env.qq.timeoutActions.add('send_group_msg')
    env.guard.notifier.push(report())
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(4) // 原来就是 4 条，每条只发一次
  })

  it('什么都被拒（例如机器人被禁言）：拆开重发也不超过每小时 30 条；一小时后的第一条说明之前有几条没发出', async () => {
    env = await setup()
    env.qq.refuseSend = (_, groupId) => groupId === ADMIN_GROUP
    env.guard.notifier.push(report())
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(30)
    env.guard.notifier.push('测试通知')
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(30)
    env.qq.refuseSend = null
    env.clock.now += HOUR
    env.guard.notifier.push('测试通知')
    const [message] = await env.adminMessages()
    // 6 = 第 1 条拆出来的 2 段 + 后面 3 条 + 限速期间的「测试通知」
    expect(message).toBe('（之前有 6 条通知因为限速没有发出，请看 Koishi 日志）\n测试通知')
  })

  it('拆出来的消息计入每小时上限：前面已经发了 26 条，被拒的那条只能再发 3 条，其余只写日志', async () => {
    env = await setup()
    for (let i = 0; i < 26; i++) {
      env.guard.notifier.push(`通知 ${i}`)
      await env.guard.notifier.flush()
    }
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && listLines(text) > 5
    env.guard.notifier.push(Array.from({ length: 20 }, (_, i) => `· 名字${40001 + i}(${40001 + i})`).join('\n'))
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(30)
    env.qq.refuseSend = null
    env.clock.now += HOUR
    env.guard.notifier.push('测试通知')
    expect((await env.adminMessages()).at(-1)).toMatch(/^（之前有 \d+ 条通知因为限速没有发出/)
  })

  it('被拒的那条带着「之前有 N 条没发出」的说明：拆开后说明留在第一段，不会丢', async () => {
    env = await setup()
    for (let i = 0; i < 30; i++) {
      env.guard.notifier.push(`通知 ${i}`)
      await env.guard.notifier.flush()
    }
    env.guard.notifier.push('这条被限速') // 只写日志
    await env.guard.notifier.flush()
    env.clock.now += HOUR
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && listLines(text) > 10
    env.guard.notifier.push(Array.from({ length: 20 }, (_, i) => `· 名字${40001 + i}(${40001 + i})`).join('\n'))
    const messages = (await env.adminMessages()).slice(30)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatch(/^（之前有 1 条通知因为限速没有发出，请看 Koishi 日志）\n（1\/1-1）· 名字40001\(40001\)/)
    expect(messages[1].startsWith('（1/1-2）')).toBe(true)
  })

  it('隐藏名字后仍被拒：只再试这一次，然后只写日志', async () => {
    env = await setup()
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && text.includes('(40025)')
    env.guard.notifier.push(report())
    await env.guard.notifier.flush()
    expect(adminSends().filter((c) => JSON.stringify(c.params).includes(HIDDEN))).toHaveLength(1)
    expect(delivered().join('\n')).not.toContain('(40025)')
    expect(delivered().flatMap(names)).toHaveLength(79)
  })

  it('日志写明哪一条被拆开、拆成几条、有没有全部送达', async () => {
    env = await setup()
    const warn = vi.spyOn(env.guard.logger, 'warn')
    const logs = () => warn.mock.calls.map((c) => {
      let i = 1
      return String(c[0]).replace(/%[sd]/g, () => String(c[i++]))
    })
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && listLines(text) > 10
    env.guard.notifier.push(Array.from({ length: 20 }, (_, i) => `· 名字${40001 + i}(${40001 + i})`).join('\n'))
    await env.guard.notifier.flush()
    expect(logs()).toContain('运维通知「· 名字40001(40001)…」被 QQ 拒收，拆成 2 条重发，全部送达')
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && text.includes('禁止')
    env.guard.notifier.push('【标题】禁止\n· 名字(40002)')
    await env.guard.notifier.flush()
    expect(logs()).toContain('运维通知（1/1-1）没有发出（被 QQ 拒收，没法再拆），只写日志：【标题】禁止')
    expect(logs()).toContain('运维通知「【标题】禁止…」被 QQ 拒收，拆成 2 条重发，没有全部送达：1 条送达，1 条没发出（内容见前面的日志）')
  })

  it('带「之前有 N 条没发出」说明的那条超时：说明算已经发过，下一条不再重复', async () => {
    env = await setup()
    for (let i = 0; i < 30; i++) {
      env.guard.notifier.push(`通知 ${i}`)
      await env.guard.notifier.flush()
    }
    env.guard.notifier.push('这条被限速')
    await env.guard.notifier.flush()
    env.clock.now += HOUR
    env.qq.timeoutActions.add('send_group_msg')
    env.guard.notifier.push('超时的那条')
    await env.guard.notifier.flush()
    env.qq.timeoutActions.clear()
    env.guard.notifier.push('下一条')
    expect((await env.adminMessages()).at(-1)).toBe('下一条')
  })

  it('发往运维群的其他失败（不是拒收，例如连接断了）：不拆、只发一次', async () => {
    env = await setup()
    const original = env.qq.handle.bind(env.qq)
    env.qq.handle = (action, params) => {
      if (action === 'send_group_msg' && String(params.group_id) === ADMIN_GROUP) {
        env.qq.calls.push({ action, params, at: Date.now() })
        throw new Error('socket closed')
      }
      return original(action, params)
    }
    env.guard.notifier.push('· 张三(40001)\n· 李四(40002)\n· 王五(40003)')
    await env.guard.notifier.flush()
    expect(adminSends()).toHaveLength(1)
  })

  it('两轮发送同时开始（例如上一轮还没发完又来了新通知）：一轮一轮地发，「之前有 N 条没发出」只说一次', async () => {
    env = await setup()
    for (let i = 0; i < 32; i++) {
      env.guard.notifier.push(`通知 ${i}`)
      await env.guard.notifier.flush()
    }
    env.clock.now += HOUR
    ;(env.guard.platform as any).sendGapMs = 100 // 让 A 还在排队发的时候 B 就来了
    env.guard.notifier.push('A')
    const first = env.guard.notifier.flush()
    await sleep(20)
    env.guard.notifier.push('B')
    const second = env.guard.notifier.flush()
    await Promise.all([first, second])
    env.guard.notifier.push('C')
    const messages = (await env.adminMessages()).slice(-3)
    expect(messages).toEqual(['（之前有 2 条通知因为限速没有发出，请看 Koishi 日志）\nA', 'B', 'C'])
  })

  it('真的巡检：3 个群各 15 个没绑定的人，报告分成几条、每条最多 20 行名单，名字一个不少', async () => {
    env = await setup()
    const extra = ['444444441', '444444442']
    for (const groupId of extra) {
      env.aa.groups.push({ group_id: groupId, name: `群${groupId.slice(-1)}`, kind: 'fixed' })
      env.qq.addGroup(groupId, [
        { user_id: +BOT, role: 'admin', card: '机器人', nickname: 'bot' },
        ...Array.from({ length: 15 }, (_, i) => plainMember(`${groupId.slice(-1)}${50001 + i}`, `名片${groupId.slice(-1)}${50001 + i}`)),
      ])
    }
    addMembers(...Array.from({ length: 15 }, (_, i) => String(40001 + i)))
    await env.guard.refreshGroups()
    env.qq.refuseSend = (text, groupId) => groupId === ADMIN_GROUP && listLines(text) > 20
    await env.guard.runPatrol()
    const messages = await env.adminMessages()
    for (const m of messages) expect(listLines(m)).toBeLessThanOrEqual(20)
    const all = messages.join('\n')
    for (let i = 0; i < 15; i++) {
      expect(all).toContain(`(${40001 + i})`)
      expect(all).toContain(`(1${50001 + i})`)
      expect(all).toContain(`(2${50001 + i})`)
    }
    expect(delivered()).toHaveLength(adminSends().length) // 一条都没被拒
  })
})

describe('群里的提醒、移出公告、命令回复也拆小重发；任意两条消息相隔 2 秒（0.2.4）', () => {
  const HIDDEN = '（名字含 QQ 不允许的内容，已隐藏）'
  const ats = (text: string) => text.match(/@\d+/g)?.length ?? 0
  const people = Array.from({ length: 12 }, (_, i) => String(40001 + i))
  const tracked = async (qq: string) => (await env.guard.store.tracked(GROUP)).get(qq)

  /** 12 个没绑定的人；设好模式并巡检一轮（加上标记）。 */
  async function unbound(mode: Mode) {
    env = await setup({ breakerCount: 100, breakerPercent: 100 })
    addMembers(...people)
    await enableMode(mode)
    await env.adminMessages()
  }

  /** 6 个已到期、刚提醒过的人（enforce）。 */
  async function dueForKick(cards: Record<string, string> = {}) {
    env = await setup({ breakerCount: 100, breakerPercent: 100 })
    const due = people.slice(0, 6)
    const group = env.qq.groups.get(GROUP)!
    for (const qq of due) group.set(qq, plainMember(qq, `【SPY】${cards[qq] ?? `名片${qq}`}`))
    const now = env.clock.now
    await env.guard.store.saveTracked(due.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(now - 72 * HOUR), marked: true,
      activeSince: new Date(now - 72 * HOUR), lastRemindedAt: new Date(now - HOUR), graceUntil: new Date(now - 60_000),
    })))
    setMode('enforce')
    return due
  }

  it('每日提醒被拒（超过 5 个 @ 就拒）：拆小重发，12 个人都提醒到、都记了截止时间', async () => {
    await unbound('enforce')
    env.qq.refuseSend = (text, target) => target === GROUP && ats(text) > 5
    await env.guard.runReminders()
    const messages = env.qq.groupMessages(GROUP)
    expect(messages.flatMap((m) => m.ats).sort()).toEqual(people)
    for (const m of messages) expect(m.ats.length).toBeLessThanOrEqual(5)
    for (const qq of people) expect((await tracked(qq))!.graceUntil).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('已提醒 12 人')
  })

  it('只 @ 某一个人也被拒：其他人照常提醒；这个人不算提醒过（不定截止时间，不会因此被移出），运维群有 ⚠', async () => {
    await unbound('enforce')
    env.qq.refuseSend = (text, target) => target === GROUP && text.includes('@40007')
    await env.guard.runReminders()
    const reminded = env.qq.groupMessages(GROUP).flatMap((m) => m.ats)
    expect(reminded.sort()).toEqual(people.filter((qq) => qq !== '40007'))
    expect((await tracked('40007'))!.lastRemindedAt).toBeNull()
    expect((await tracked('40007'))!.graceUntil).toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('提醒没有发出去（1 人）')
  })

  it('移出公告被拒（名字超过 2 个就拒）：拆小重发，6 个名字都公告了', async () => {
    const due = await dueForKick()
    env.qq.refuseSend = (text, target) => target === GROUP && (text.match(/、/g)?.length ?? 0) >= 2
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(6)
    const announced = env.qq.groupMessages(GROUP).filter((m) => m.text.includes('已被移出')).map((m) => m.text).join('\n')
    for (const qq of due) expect(announced).toContain(`名片${qq}`)
    expect(announced).not.toContain(HIDDEN)
  })

  it('移出公告里某个名字单独也被拒：只隐藏这个名字', async () => {
    await dueForKick({ 40003: '坏词名字' })
    env.qq.refuseSend = (text, target) => target === GROUP && text.includes('坏词')
    await env.guard.runPatrol()
    const announced = env.qq.groupMessages(GROUP).filter((m) => m.text.includes('已被移出')).map((m) => m.text).join('\n')
    expect(announced).not.toContain('坏词')
    expect(announced).toContain(HIDDEN)
    for (const qq of ['40001', '40002', '40004', '40005', '40006']) expect(announced).toContain(`名片${qq}`)
  })

  it('命令回复被拒（私聊超过 3 行就拒）：拆小重发，内容一行不少', async () => {
    env = await setup()
    env.qq.refuseSend = (text, target) => target === OPERATOR && text.split('\n').length > 3
    const before = env.qq.sent.length
    await env.say(OPERATOR, 'aaqq')
    await sleep(500)
    const replies = env.qq.sent.slice(before).filter((m) => m.target === OPERATOR).map((m) => m.text)
    expect(replies.length).toBeGreaterThan(1)
    for (const r of replies) expect(r.split('\n').length).toBeLessThanOrEqual(3)
    const all = replies.join('\n')
    for (const command of ['aaqq.status', 'aaqq.health', 'aaqq.patrol', 'aaqq.confirm', 'aaqq.check', 'aaqq.pause', 'aaqq.resume']) expect(all).toContain(command)
  })

  it('任意两条消息之间至少隔开设定的时间：运维通知、群里的提醒、私聊回复排在一起一条一条地发', async () => {
    await unbound('remind')
    const gap = 150
    ;(env.guard.platform as any).sendGapMs = gap
    const start = env.qq.calls.length
    for (let i = 0; i < 3; i++) env.guard.notifier.push(`通知 ${i}：${'字'.repeat(1400)}`)
    await Promise.all([env.guard.notifier.flush(), env.guard.runReminders(), env.say(OPERATOR, 'aaqq')])
    await sleep(gap * 3)
    const sends = env.qq.calls.slice(start).filter((c) => c.action === 'send_group_msg' || c.action === 'send_private_msg')
    expect(sends.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < sends.length; i++) expect(sends[i].at - sends[i - 1].at).toBeGreaterThanOrEqual(gap - 5)
  })

  it('排队等着发的提醒：这期间 aaqq.pause 了 → 不发', async () => {
    await unbound('remind')
    ;(env.guard.platform as any).sendGapMs = 200
    for (let i = 0; i < 3; i++) env.guard.notifier.push(`通知 ${i}：${'字'.repeat(1400)}`)
    const flushing = env.guard.notifier.flush()
    const reminding = env.guard.runReminders()
    await sleep(100)
    await env.guard.setPaused(true, OPERATOR)
    await Promise.all([flushing, reminding])
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    expect((await tracked('40001'))!.lastRemindedAt).toBeNull()
  })
})

describe('消息分段（K13）', () => {
  async function addGroups(count: number, nameLength: number) {
    for (let i = 0; i < count; i++) {
      env.aa.groups.push({ group_id: String(100000000 + i), name: `第${i}号${'很长的群名字'.repeat(Math.ceil(nameLength / 6))}`, kind: 'fixed' })
    }
    await env.guard.refreshGroups()
  }

  /** 以运维身份私聊命令，等回复发完。 */
  async function command(text: string) {
    const before = env.qq.sent.length
    await env.say(OPERATOR, text)
    await sleep(500)
    return env.qq.sent.slice(before).filter((m) => m.target === OPERATOR).map((m) => m.text)
  }

  it('aaqq.status 很长：分成几条发，每条不超过 1500 字，带（1/N）', async () => {
    env = await setup()
    await addGroups(40, 30)
    const replies = await command('aaqq.status')
    expect(replies.length).toBeGreaterThanOrEqual(2)
    expect(replies[0].startsWith('（1/')).toBe(true)
    for (const reply of replies) expect(charLength(reply)).toBeLessThanOrEqual(1500)
    expect(replies.join('\n')).toContain('第39号')
  })

  it('命令回复超过 5 条：只发 5 条，最后一条说其余见日志', async () => {
    env = await setup()
    await addGroups(150, 90)
    const replies = await command('aaqq.status')
    expect(replies).toHaveLength(5)
    expect(replies[4]).toContain('其余见 Koishi 日志')
  })

  it('群里的 @ 提醒：模板很长时自动拆成多条，每条不超过 1500 字，每人只被 @ 一次', async () => {
    const head = '请尽快绑定'.repeat(280) // 1400 字
    env = await setup({ remindTemplate: `${head}\n{list}`, breakerCount: 100, breakerPercent: 100 }) // 20 人一起开始处置不进冷静期
    const people = Array.from({ length: 20 }, (_, i) => String(40001 + i))
    addMembers(...people)
    await enableMode('remind')
    await env.guard.runReminders()
    const messages = env.qq.groupMessages(GROUP)
    expect(messages.length).toBeGreaterThan(1)
    for (const m of messages) {
      expect(charLength(m.text)).toBeLessThanOrEqual(1500)
      expect(m.text.startsWith('请尽快绑定')).toBe(true)
    }
    expect(messages.flatMap((m) => m.ats).sort()).toEqual(people)
  })
})

describe('名单骤减检测不只挡一轮（K12）', () => {
  it('可疑之后下一轮人数又不一样：仍然可疑，「上一轮人数」不变；连续两轮一样才恢复', async () => {
    env = await setup()
    const people = Array.from({ length: 20 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `名片${qq}`)
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).lastRosterSize).toBe(23)
    const group = env.qq.groups.get(GROUP)!
    for (const qq of people.slice(0, 12)) group.delete(qq)
    await env.guard.runPatrol() // 11 人：可疑
    expect(env.aa.last('check')!.body.full_roster).toBe(false)
    for (const qq of people.slice(12, 15)) group.delete(qq)
    await env.guard.runPatrol() // 8 人：和上一轮不一样，仍然可疑
    expect(env.aa.last('check')!.body.full_roster).toBe(false)
    const state = await env.guard.store.groupState(GROUP)
    expect(state.lastRosterSize).toBe(23)
    expect(state.rosterCandidate).toBe(8)
    await env.adminMessages()
    await env.guard.runPatrol() // 还是 8 人：当作真的退群
    expect(env.aa.last('check')!.body.full_roster).toBe(true)
    expect((await env.guard.store.groupState(GROUP)).lastRosterSize).toBe(8)
    expect((await env.adminMessages()).at(-1)).toContain('ℹ 连续两轮名单都是 8 人（上次完整名单 23 人），按真的退群处理')
  })
})

describe('数据迁移（0.1.x → 0.2.0）', () => {
  it('旧记录：activeSince = firstDeniedAt，schema = 2；再迁移一次什么都不改', async () => {
    env = await setup()
    await env.guard.migrated
    const first = new Date(env.clock.now - 72 * HOUR)
    const old = { groupId: GROUP, reason: 'NOT_BOUND', firstDeniedAt: first, graceUntil: null, marked: true, lastRemindedAt: null }
    await env.app.database.upsert('aaqqbot_member', [{ ...old, qq: '40001' }])
    await env.guard.store.removeKv('schema')
    await env.guard.store.migrate()
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.activeSince).toEqual(first)
    expect(await env.guard.store.getKv('schema')).toBe(2)
    await env.app.database.upsert('aaqqbot_member', [{ ...old, qq: '40002' }])
    await env.guard.store.migrate()
    expect((await env.guard.store.tracked(GROUP)).get('40002')!.activeSince).toBeNull()
  })

  it('已经在处置中的 remind 群：旧记录迁移后算「处置过」，不会因此进冷静期', async () => {
    env = await setup()
    await env.guard.migrated
    const people = ['40001', '40002', '40003', '40004', '40005', '40006']
    const group = env.qq.groups.get(GROUP)!
    for (const qq of people) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    await env.app.database.upsert('aaqqbot_member', people.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(env.clock.now - 72 * HOUR), graceUntil: null, marked: true, lastRemindedAt: null,
    })))
    await env.app.database.upsert('aaqqbot_group', [{ groupId: GROUP, confirmedMode: 'remind', lastPatrolAt: new Date(env.clock.now - HOUR), lastPatrolOk: true, lastRosterSize: 9 }])
    await env.guard.store.removeKv('schema')
    await env.guard.start() // 插件升级后重启
    setMode('remind')
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    const report = (await env.adminMessages()).join('\n')
    expect(report).not.toContain('冷静期')
    expect(report).toContain('仍不合格 6 人')
    expect(report).not.toContain('模式已从')
  })

  it('只有旧字段、在熔断中的群改成 report：巡检不出错，冷静期取消', async () => {
    env = await setup()
    await env.app.database.upsert('aaqqbot_group', [{ groupId: GROUP, confirmedMode: 'enforce', holdSince: new Date(env.clock.now - HOUR), holdNote: '新增不合格 8 人' }])
    expect(await env.guard.runPatrol()).toBe('done')
    expect((await env.adminMessages()).join('\n')).toContain('改成了 report，冷静期取消')
  })
})

describe('0.2.1 修补', () => {
  const spyCards = () => env.qq.actions('set_group_card').filter((c) => String(c.params.card).startsWith('【SPY】'))
  const marked = (qq: string) => env.qq.member(GROUP, qq)!.card.startsWith('【SPY】')
  let eventId = 0

  /** AA 上这些人变成不合格，并发出对应的事件，然后拉一次变化。 */
  async function denyByEvents(qqs: string[]) {
    for (const qq of qqs) {
      env.aa.deny(qq, 'NO_ACCESS')
      env.aa.events.push({ id: ++eventId, kind: 'recheck', qq })
    }
    await env.guard.pollEvents()
  }

  /** 阈值 5 的 remind 群：12 个合格成员。 */
  async function thresholdFiveGroup() {
    env = await setup({ breakerPercent: 100 })
    eventId = 0
    const people = Array.from({ length: 12 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `名片${qq}`)
    await enableMode('remind')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    return people
  }

  it('P1 分批到达：3、3、3 人陆续变成不合格 → 第 2 批时进入冷静期，这 3 人不加标记；第 3 批仍在冷静中', async () => {
    const people = await thresholdFiveGroup()
    await denyByEvents(people.slice(0, 3))
    expect(people.slice(0, 3).every(marked)).toBe(true)
    await denyByEvents(people.slice(3, 6))
    expect(people.slice(3, 6).some(marked)).toBe(false)
    const state = await env.guard.store.groupState(GROUP)
    expect(state.holdSince).not.toBeNull()
    expect(JSON.parse(state.holdSet).sort()).toEqual(people.slice(0, 6))
    await denyByEvents(people.slice(6, 9))
    expect(people.slice(6, 9).some(marked)).toBe(false)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('⏸ 冷静期开始：联盟聊天群（111111111） 最近 6 小时内要开始处置的不合格成员有 6 人（这一轮 3 人、之前 3 人，超过阈值 5 人）')
  })

  it('P1 冷静期结束后处置的那批不再计入：之后一小时内再来 3 个新的不触发', async () => {
    const people = await thresholdFiveGroup()
    await denyByEvents(people.slice(0, 3))
    await denyByEvents(people.slice(3, 6)) // 进入冷静期
    env.clock.now += 6 * HOUR
    await env.guard.runPatrol() // 还是那批人 → 结束，处置
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(people.slice(0, 6).every(marked)).toBe(true)
    const released = (await env.adminMessages()).join('\n')
    expect(released).toContain('▶ 冷静期结束：联盟聊天群（111111111） 情况和 6 小时前一致，开始正常处置。')
    expect(released).not.toContain('已恢复正常')
    env.clock.now += HOUR
    await denyByEvents(people.slice(6, 9))
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(people.slice(6, 9).every(marked)).toBe(true)
  })

  it('R1 冷静中窗口不跟着时间走：之前处置的人「老化」出 6 小时也不提前结束冷静', async () => {
    const people = await thresholdFiveGroup()
    await denyByEvents(people.slice(0, 3))
    env.clock.now += 5 * HOUR + 50 * 60_000
    await denyByEvents(people.slice(3, 6)) // 3 + 3 > 5 → 进入冷静期
    const since = (await env.guard.store.groupState(GROUP)).holdSince!.getTime()
    env.clock.now += 15 * 60_000 // 第 1 批处置已经过去 6 小时 5 分钟
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince!.getTime()).toBe(since)
    expect(people.slice(3, 6).some(marked)).toBe(false)
    await denyByEvents(people.slice(6, 11)) // 冷静中再来 5 人：仍然不处置
    expect(people.slice(6, 11).some(marked)).toBe(false)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).not.toContain('冷静期结束')
  })

  it('R1 冷静中有人真的变回合格 → 马上结束，报「已恢复正常」', async () => {
    const people = await thresholdFiveGroup()
    await denyByEvents(people.slice(0, 3))
    await denyByEvents(people.slice(3, 6)) // 进入冷静期
    env.aa.allow(people[3], `名片${people[3]}`)
    env.aa.allow(people[4], `名片${people[4]}`)
    env.clock.now += 10 * 60_000
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(marked(people[5])).toBe(true)
    expect((await env.adminMessages()).join('\n')).toContain('▶ 冷静期结束：联盟聊天群（111111111） 已恢复正常。')
  })

  it('P1 窗口过期：第 1 批处置后 7 小时再来 3 人，不触发', async () => {
    const people = await thresholdFiveGroup()
    await denyByEvents(people.slice(0, 3))
    env.clock.now += 7 * HOUR
    await denyByEvents(people.slice(3, 6))
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(people.slice(0, 6).every(marked)).toBe(true)
  })

  it('P1 移出分批：第 1 轮到期 3 人被移出，1 小时后又到期 3 人 → 第 2 轮进入冷静期、0 移出', async () => {
    env = await setup({ breakerPercent: 100 })
    const early = ['40001', '40002', '40003']
    const late = ['40004', '40005', '40006']
    const group = env.qq.groups.get(GROUP)!
    for (const qq of [...early, ...late]) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    const now = env.clock.now
    await env.guard.store.saveTracked([...early, ...late].map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(now - 72 * HOUR), marked: true,
      activeSince: new Date(now - 72 * HOUR), lastRemindedAt: new Date(now - HOUR),
      graceUntil: new Date(early.includes(qq) ? now - 60_000 : now + 59 * 60_000),
    })))
    setMode('enforce')
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(3)
    expect(await env.guard.store.countAudit('kick', GROUP, new Date(0))).toBe(3)
    env.clock.now += HOUR
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toHaveLength(3)
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('最近 6 小时内到期要移出的有 6 人（这一轮 3 人、已经移出 3 人，超过阈值 5 人）')
  })

  it('P2 迁移中途失败再重跑：0.2.x 自己写的「只记录」行不会被当成「处置过」', async () => {
    env = await setup()
    await env.guard.migrated
    const old = (qq: string) => ({ groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(env.clock.now - 72 * HOUR), graceUntil: null, marked: true, lastRemindedAt: null })
    await env.app.database.upsert('aaqqbot_member', [old('40001'), old('40002')])
    await env.guard.store.removeKv('schema')
    await env.guard.store.removeKv('migrationCutoff')
    const db = env.app.database as any
    const originalSet = db.set.bind(db)
    let calls = 0
    db.set = async (...args: any[]) => {
      if (args[0] === 'aaqqbot_member' && ++calls === 2) throw new Error('db down')
      return originalSet(...args)
    }
    await expect(env.guard.store.migrate()).rejects.toThrow('db down')
    db.set = originalSet
    // 0.2.x 照常运行，写下一条「只记录」行
    env.clock.now += 60_000
    await env.guard.store.saveTracked([{ ...old('40003'), firstDeniedAt: new Date(env.clock.now), marked: false, activeSince: null }])
    await env.guard.store.migrate()
    const rows = await env.guard.store.tracked(GROUP)
    expect(rows.get('40001')!.activeSince).not.toBeNull()
    expect(rows.get('40002')!.activeSince).not.toBeNull()
    expect(rows.get('40003')!.activeSince).toBeNull()
    expect(await env.guard.store.getKv('schema')).toBe(2)
  })

  it('P3 冷静期很长（40 小时）：到期的人不会因为「提醒过期」被当成已恢复；截止时间清空，重新提醒后再算', async () => {
    env = await setup({ breakerCooldownHours: 40 })
    const people = Array.from({ length: 30 }, (_, i) => String(40001 + i))
    const group = env.qq.groups.get(GROUP)!
    for (const qq of people) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    const now = env.clock.now
    await env.guard.store.saveTracked(people.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(now - 72 * HOUR), marked: true,
      activeSince: new Date(now - 72 * HOUR), lastRemindedAt: new Date(now - HOUR), graceUntil: new Date(now - 60_000),
    })))
    setMode('enforce')
    await env.guard.runPatrol() // 30 人同时到期 → 冷静
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    env.clock.now += 40 * HOUR
    await env.guard.runReminders() // 冷静中不提醒
    await env.guard.runPatrol() // 还是那批人 → 结束
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('开始正常处置（30 人的截止时间已过期，重新提醒后再算宽限期）')
    expect(messages).not.toContain('已恢复正常')
    expect([...(await env.guard.store.tracked(GROUP)).values()].every((r) => r.graceUntil === null)).toBe(true)
    await env.guard.runReminders()
    expect((await env.guard.store.tracked(GROUP)).get('40001')!.graceUntil!.getTime()).toBe(env.clock.now + 48 * HOUR)
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('P4 加标记前实时复核（「群主/管理员也加标记」关掉时）：刚被设为管理员的人不加标记', async () => {
    env = await setup({ markAdmins: false })
    addMembers('40001')
    const original = env.qq.handle.bind(env.qq)
    env.qq.handle = (action, params) => {
      const result = original(action, params)
      if (action === 'get_group_member_info' && params.user_id === 40001) result.data = { ...result.data, role: 'admin' }
      return result
    }
    await enableMode('remind')
    expect(spyCards()).toEqual([])
    expect((await env.adminMessages()).at(-1)).toContain('· 加标记前复核后跳过 1 人（已经不是普通成员或不在群里）')
  })

  for (const botRole of ['owner', 'admin'] as const) {
    it(`P4 带【SPY】的管理员（机器人是${botRole === 'owner' ? '群主' : '管理员'}，「群主/管理员也加标记」关掉）：下一轮撤掉标记、删记录`, async () => {
      env = await setup({ markAdmins: false })
      if (botRole === 'owner') {
        env.qq.member(GROUP, BOT)!.role = 'owner'
        env.qq.member(GROUP, OWNER)!.role = 'admin'
      }
      env.qq.groups.get(GROUP)!.set('40001', { user_id: 40001, role: 'admin', card: '【SPY】张三', nickname: 'x' })
      await env.guard.store.saveTracked([{
        groupId: GROUP, qq: '40001', reason: 'NOT_BOUND', firstDeniedAt: new Date(0), graceUntil: null, marked: true,
        lastRemindedAt: null, activeSince: new Date(0),
      }])
      await enableMode('remind')
      expect(env.qq.member(GROUP, '40001')!.card).toBe('张三')
      expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(false)
    })
  }

  it('P4 QQ 不让撤管理员身上的标记（「群主/管理员也加标记」关掉）：记录保留，运维群列出来，下一轮再试', async () => {
    env = await setup({ markAdmins: false })
    env.qq.groups.get(GROUP)!.set('40001', { user_id: 40001, role: 'admin', card: '【SPY】张三', nickname: 'x' })
    await env.guard.store.saveTracked([{
      groupId: GROUP, qq: '40001', reason: 'NOT_BOUND', firstDeniedAt: new Date(0), graceUntil: null, marked: true,
      lastRemindedAt: null, activeSince: new Date(0),
    }])
    env.qq.failCard.add('40001')
    await enableMode('remind')
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(true)
    expect((await env.adminMessages()).at(-1)).toContain('群主/管理员的名片机器人改不了（请自己改成箭头后面的样子）1 人\n· 张三(40001) → 张三')
    env.qq.failCard.clear()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('张三')
    expect((await env.guard.store.tracked(GROUP)).has('40001')).toBe(false)
  })

  it('P5 0.1.x 里没确认过的升级（已确认 remind、配置 enforce）：旧记录重新算第一次处置，照样先冷静', async () => {
    env = await setup({ breakerPercent: 100 })
    await env.guard.migrated
    const people = ['40001', '40002', '40003', '40004', '40005', '40006']
    const group = env.qq.groups.get(GROUP)!
    for (const qq of people) group.set(qq, plainMember(qq, `【SPY】名片${qq}`))
    await env.guard.store.saveTracked(people.map((qq) => ({
      groupId: GROUP, qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(env.clock.now - 72 * HOUR), graceUntil: null, marked: true,
      lastRemindedAt: new Date(env.clock.now - 20 * HOUR), activeSince: new Date(env.clock.now - 72 * HOUR),
    })))
    await env.app.database.upsert('aaqqbot_group', [{
      groupId: GROUP, confirmedMode: 'remind', lastPatrolAt: new Date(env.clock.now - HOUR), lastPatrolOk: true, lastRosterSize: 9,
    }])
    setMode('enforce')
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    await env.guard.runReminders()
    expect([...(await env.guard.store.tracked(GROUP)).values()].every((r) => r.graceUntil === null)).toBe(true)
  })
})

describe('不合格的群主、管理员也加标记并提醒（0.2.2）', () => {
  const ADMIN_TEXT = '以下群主/管理员还没有满足本群的要求（不会被移出）'

  it('remind：群主、管理员加上【SPY】，报告里标明「不移出」；每日提醒单独一条、没有截止时间', async () => {
    env = await setup({ breakerPercent: 100 })
    addMembers('40001')
    env.aa.deny(OWNER)
    env.aa.deny(ADMIN)
    await enableMode('remind')
    expect(env.qq.member(GROUP, OWNER)!.card).toBe('【SPY】群主')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('【SPY】管理员')
    expect(env.qq.member(GROUP, BOT)!.card).toBe('机器人')
    const report = (await env.adminMessages()).at(-1)!
    expect(report).toContain('· 群主(10001)（群主，不移出）')
    expect(report).toContain('· 管理员(10002)（管理员，不移出）')
    expect(report).not.toContain('不合格但受保护')
    await env.guard.runReminders()
    const messages = env.qq.groupMessages(GROUP)
    const staff = messages.find((m) => m.text.includes(ADMIN_TEXT))!
    expect(staff.ats.sort()).toEqual([OWNER, ADMIN].sort())
    expect(staff.text).not.toContain('截止')
    const normal = messages.find((m) => !m.text.includes(ADMIN_TEXT))!
    expect(normal.ats).toEqual(['40001'])
    expect((await env.adminMessages()).join('\n')).toContain('已提醒 3 人')
  })

  it('enforce：管理员永远没有截止时间、永远不移出；普通成员照常', async () => {
    env = await setup({ breakerPercent: 100 })
    addMembers('40001')
    env.aa.deny(ADMIN)
    await enableMode('enforce')
    await env.guard.runReminders()
    for (let day = 0; day < 4; day++) {
      env.clock.now += 24 * HOUR
      await env.guard.runReminders()
      await env.guard.runPatrol()
    }
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('【SPY】管理员')
    expect((await env.guard.store.tracked(GROUP)).get(ADMIN)!.graceUntil).toBeNull()
    expect(env.qq.actions('set_group_kick').map((c) => String(c.params.user_id))).toEqual(['40001'])
  })

  it('白名单里的管理员：不加标记、不提醒', async () => {
    env = await setup({ whitelist: [ADMIN] })
    env.aa.deny(ADMIN)
    await enableMode('remind')
    await env.guard.runReminders()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('管理员')
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    expect((await env.adminMessages()).join('\n')).toContain('不合格但受保护 1 人')
  })

  it('合格以后：名片改成 AA 的，记录删掉', async () => {
    env = await setup()
    env.aa.deny(ADMIN)
    await enableMode('remind')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('【SPY】管理员')
    env.aa.allow(ADMIN, '[IGC] 管理员')
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('[IGC] 管理员')
    expect((await env.guard.store.tracked(GROUP)).has(ADMIN)).toBe(false)
  })

  it('开关关掉后：下一轮撤掉他们身上的标记', async () => {
    env = await setup()
    env.aa.deny(ADMIN)
    await enableMode('remind')
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('【SPY】管理员')
    env.config.markAdmins = false
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, ADMIN)!.card).toBe('管理员')
    expect((await env.guard.store.tracked(GROUP)).has(ADMIN)).toBe(false)
  })

  it('report 模式：只报告、不加标记，下一轮算「仍不合格」', async () => {
    env = await setup()
    env.aa.deny(ADMIN)
    await env.guard.runPatrol()
    expect((await env.adminMessages()).at(-1)).toContain('新发现不合格 1 人\n【没有在 AA 绑定 QQ】\n· 管理员(10002)（管理员，不移出）')
    await env.guard.runPatrol()
    expect((await env.adminMessages()).at(-1)).toContain('仍不合格 1 人')
    expect(env.qq.actions('set_group_card')).toEqual([])
  })
})

describe('离开联盟的人：马上提醒，2 小时后移出（0.2.3 F1）', () => {
  const LABEL = '联盟聊天群（111111111）'
  const FAST_TEXT = '已不再具备本群成员资格'
  let eventId = 0
  const tracked = async (qq: string) => (await env.guard.store.tracked(GROUP)).get(qq)

  /** 40001 原来合格；进入某个模式；然后 AA 把他判成 reason 并发出事件。 */
  async function leave(mode: Mode, reason = 'NO_ACCESS', config: Parameters<typeof setup>[0] = {}) {
    env = await setup(config)
    eventId = 0
    addMembers('40001')
    env.aa.allow('40001', '名片40001')
    await enableMode(mode)
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    await env.adminMessages()
    env.aa.deny('40001', reason)
    env.aa.events.push({ id: ++eventId, kind: 'recheck', qq: '40001' })
    await env.guard.pollEvents()
  }

  it('enforce：AA 判成「没有成员资格」→ 马上 @、2 小时后不经巡检就移出，运维群有 ⚡', async () => {
    await leave('enforce')
    const t = env.clock.now
    const message = env.qq.groupMessages(GROUP).at(-1)!
    expect(message.ats).toEqual(['40001'])
    expect(message.text).toContain(FAST_TEXT)
    expect((await tracked('40001'))!.graceUntil!.getTime()).toBe(t + 2 * HOUR)
    expect(env.guard.nextFastKickAt).toBe(t + 2 * HOUR)
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    expect((await env.adminMessages()).join('\n')).toContain(`⚡ ${LABEL} 名片40001(40001) 已不具备成员资格（AA 账号没有成员资格），已提醒，`)
    const fullRosterChecks = env.aa.requests.filter((r) => r.name === 'check' && r.body.full_roster).length
    env.clock.now = t + 2 * HOUR + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
    expect(env.aa.requests.filter((r) => r.name === 'check' && r.body.full_roster).length).toBe(fullRosterChecks) // 没有巡检
    const [kick] = await env.guard.store.auditSince('kick', GROUP, new Date(0))
    expect(kick.detail).toContain('离开联盟')
    expect((await env.adminMessages()).join('\n')).toContain('【离开联盟到期处理】')
  })

  it('「账号已停用」一样；「没有绑定 QQ」不马上提醒，照旧 48 小时', async () => {
    await leave('enforce', 'USER_INACTIVE')
    expect(env.qq.groupMessages(GROUP).at(-1)!.text).toContain(FAST_TEXT)
    await env.stop()
    await leave('enforce', 'NOT_BOUND')
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    expect((await tracked('40001'))!.graceUntil).toBeNull()
    expect(env.guard.nextFastKickAt).toBeNull()
  })

  it('截止前 AA 改回合格：到点不移出，标记撤掉，跟踪取消', async () => {
    await leave('enforce')
    env.aa.allow('40001', '名片40001')
    env.clock.now += 2 * HOUR + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('名片40001')
    expect(await tracked('40001')).toBeUndefined()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('到点时 AA 连不上：不移出、只报警一次；恢复后下一次巡检按规则移出', async () => {
    await leave('enforce')
    env.clock.now += 2 * HOUR + 60_000
    env.aa.override('check', { status: 500, body: '{}' })
    await env.guard.runFastKicks()
    await env.guard.runFastKicks()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    expect((await env.adminMessages()).join('\n').match(/AA 连接出问题/g)).toHaveLength(1)
    env.aa.overrides.clear()
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
  })

  it('到点时他刚被设为管理员（实时查身份）：不移出', async () => {
    await leave('enforce')
    const original = env.qq.handle.bind(env.qq)
    env.qq.handle = (action, params) => {
      const result = original(action, params)
      if (action === 'get_group_member_info' && params.user_id === 40001) result.data = { ...result.data, role: 'admin' }
      return result
    }
    env.clock.now += 2 * HOUR + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('群主、管理员「没有成员资格」：加标记、单独提醒，没有截止时间，永不移出', async () => {
    env = await setup()
    await enableMode('enforce')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.deny(OWNER, 'NO_ACCESS')
    env.aa.events.push({ id: 1, kind: 'recheck', qq: OWNER })
    await env.guard.pollEvents()
    expect(env.qq.member(GROUP, OWNER)!.card).toBe('【SPY】[IGC] 群主')
    expect(env.qq.groupMessages(GROUP)).toEqual([]) // 不走「马上提醒」，等每日提醒
    expect((await env.guard.store.tracked(GROUP)).get(OWNER)!.graceUntil).toBeNull()
    expect(env.guard.nextFastKickAt).toBeNull()
    await env.guard.runReminders()
    env.clock.now += 3 * HOUR
    await env.guard.runFastKicks()
    await env.guard.runPatrol()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('remind 群：马上 @ + 加标记，不定截止时间，到点不移出', async () => {
    await leave('remind')
    const message = env.qq.groupMessages(GROUP).at(-1)!
    expect(message.ats).toEqual(['40001'])
    expect(message.text).not.toContain(FAST_TEXT) // remind 模式用 remind 的提醒文字，不说移出
    expect((await tracked('40001'))!.graceUntil).toBeNull()
    expect(env.qq.member(GROUP, '40001')!.card).toBe('【SPY】名片40001')
    env.clock.now += 3 * HOUR
    await env.guard.runFastKicks()
    expect(env.qq.actions('set_group_kick')).toEqual([])
  })

  it('提醒没发出去：不定截止时间；下一次复查发出去了才定', async () => {
    env = await setup()
    eventId = 0
    addMembers('40001')
    env.aa.allow('40001', '名片40001')
    await enableMode('enforce')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.qq.failSendGroups.add(GROUP)
    env.aa.deny('40001', 'NO_ACCESS')
    env.aa.events.push({ id: ++eventId, kind: 'recheck', qq: '40001' })
    await env.guard.pollEvents()
    expect((await tracked('40001'))!.graceUntil).toBeNull()
    expect((await env.adminMessages()).join('\n')).toContain('离开联盟的提醒没有发出去（1 人），没有定截止时间')
    env.qq.failSendGroups.clear()
    env.clock.now += HOUR
    env.aa.events.push({ id: ++eventId, kind: 'recheck', qq: '40001' })
    await env.guard.pollEvents()
    expect((await tracked('40001'))!.graceUntil!.getTime()).toBe(env.clock.now + 2 * HOUR)
  })

  it('熔断：6 个人分 3 次陆续离开（阈值 5）→ 第 3 批进入冷静期、不提醒；已经在倒计时的到点也不移出', async () => {
    env = await setup({ breakerPercent: 100 })
    eventId = 0
    const people = Array.from({ length: 9 }, (_, i) => String(40001 + i))
    addMembers(...people)
    for (const qq of people) env.aa.allow(qq, `名片${qq}`)
    await enableMode('enforce')
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    for (const batch of [people.slice(0, 2), people.slice(2, 4), people.slice(4, 6)]) {
      for (const qq of batch) {
        env.aa.deny(qq, 'NO_ACCESS')
        env.aa.events.push({ id: ++eventId, kind: 'recheck', qq })
      }
      await env.guard.pollEvents()
      env.clock.now += 5 * 60_000
    }
    expect((await env.guard.store.groupState(GROUP)).holdSince).not.toBeNull()
    const reminded = env.qq.groupMessages(GROUP).flatMap((m) => m.ats)
    expect(reminded.sort()).toEqual(people.slice(0, 4))
    env.clock.now += 2 * HOUR
    await env.guard.runFastKicks()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    // 冷静期结束后：前面 4 个到期的人移出；触发冷静期的那一批走普通流程（不马上提醒，每日提醒 + 48 小时）
    env.clock.now += 4 * HOUR
    const before = env.qq.groupMessages(GROUP).length
    await env.guard.runPatrol()
    expect((await env.guard.store.groupState(GROUP)).holdSince).toBeNull()
    expect(env.qq.actions('set_group_kick').map((c) => String(c.params.user_id)).sort()).toEqual(people.slice(0, 4))
    expect(env.qq.groupMessages(GROUP).slice(before).flatMap((m) => m.ats)).toEqual([])
    for (const qq of people.slice(4, 6)) expect((await tracked(qq))!.graceUntil).toBeNull()
  })

  it('原因变了：没绑定（还有 30 小时）→ 没有成员资格，截止时间提前到 2 小时后；反过来不延长', async () => {
    env = await setup()
    eventId = 0
    addMembers('40001')
    await enableMode('enforce')
    await env.guard.runReminders()
    env.clock.now += 18 * HOUR // 截止时间还有 30 小时
    await env.guard.store.setKv(env.guard.cursorKey, 0)
    env.aa.deny('40001', 'NO_ACCESS')
    env.aa.events.push({ id: ++eventId, kind: 'recheck', qq: '40001' })
    await env.guard.pollEvents()
    const fastDeadline = env.clock.now + 2 * HOUR
    expect((await tracked('40001'))!.graceUntil!.getTime()).toBe(fastDeadline)
    env.clock.now += HOUR
    env.aa.deny('40001', 'NOT_BOUND')
    env.aa.events.push({ id: ++eventId, kind: 'recheck', qq: '40001' })
    await env.guard.pollEvents()
    expect((await tracked('40001'))!.graceUntil!.getTime()).toBe(fastDeadline)
  })

  it('插件重启时有没到期的快速截止时间：启动后按它重新安排，到点照常移出', async () => {
    await leave('enforce')
    const deadline = (await tracked('40001'))!.graceUntil!.getTime()
    env.guard.nextFastKickAt = null
    await env.guard.start()
    expect(env.guard.nextFastKickAt).toBe(deadline)
    env.clock.now = deadline + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
  })

  it('新人入群时 AA 已判「没有成员资格」：马上用离开联盟的文字提醒，2 小时后移出', async () => {
    env = await setup()
    await enableMode('enforce')
    await env.adminMessages()
    env.aa.deny('50001', 'NO_ACCESS')
    env.qq.groups.get(GROUP)!.set('50001', plainMember('50001', '新人'))
    await env.guard.handleNewMember(env.bot as any, GROUP, '50001')
    const message = env.qq.groupMessages(GROUP).at(-1)!
    expect(message.ats).toEqual(['50001'])
    expect(message.text).toContain(FAST_TEXT)
    expect((await tracked('50001'))!.graceUntil!.getTime()).toBe(env.clock.now + 2 * HOUR)
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('👋 联盟聊天群（111111111） 新成员 新人(50001)：不合格（AA 账号没有成员资格），已不具备成员资格，已马上提醒。')
    expect(messages).toContain('⚡ 联盟聊天群（111111111） 新人(50001) 已不具备成员资格')
    env.clock.now += 2 * HOUR + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.member(GROUP, '50001')).toBeUndefined()
  })

  it('冷静中来了一个「没有成员资格」的新人：不提醒，运维群说「只记录」，不说「已马上提醒」', async () => {
    env = await setup()
    await enableMode('enforce')
    await env.guard.store.setGroupState(GROUP, { holdSince: new Date(env.clock.now), holdNote: '测试', holdSet: '[]' })
    await env.adminMessages()
    env.aa.deny('50001', 'NO_ACCESS')
    env.qq.groups.get(GROUP)!.set('50001', plainMember('50001', '新人'))
    await env.guard.handleNewMember(env.bot as any, GROUP, '50001')
    expect(env.qq.groupMessages(GROUP)).toEqual([])
    const messages = (await env.adminMessages()).join('\n')
    expect(messages).toContain('这个群在冷静期，只记录')
    expect(messages).not.toContain('已马上提醒')
    expect((await tracked('50001'))!.graceUntil).toBeNull()
  })

  it('暂停期间到点：不移出；解除暂停后重新安排、复核后移出', async () => {
    await leave('enforce')
    await env.guard.setPaused(true, OPERATOR)
    env.clock.now += 2 * HOUR + 60_000
    await env.guard.runFastKicks()
    expect(env.qq.actions('set_group_kick')).toEqual([])
    await env.guard.setPaused(false, OPERATOR)
    await env.guard.runPatrol()
    expect(env.qq.member(GROUP, '40001')).toBeUndefined()
  })
})
