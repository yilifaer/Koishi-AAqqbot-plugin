import { describe, expect, it } from 'vitest'
import type { Verdict } from '../src/aa'
import type { Mode } from '../src/config'
import { breakerThreshold, Member, PlanInput, planGroup } from '../src/policy'
import type { TrackedMember } from '../src/store'

const NOW = Date.parse('2026-09-25T12:00:00+08:00')
const HOUR = 3600_000

function member(qq: string, extra: Partial<Member> = {}): Member {
  return { qq, role: 'member', card: `名片${qq}`, nickname: `昵称${qq}`, isRobot: false, ...extra }
}

function verdict(qq: string, decision: Verdict['decision'], reason = decision === 'allow' ? 'OK' : 'NOT_BOUND', card: string | null = null): Verdict {
  return { qq, decision, reason, card: decision === 'allow' ? card : null }
}

function tracked(qq: string, extra: Partial<TrackedMember> = {}): TrackedMember {
  return { groupId: '123456789', qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(NOW - 72 * HOUR), graceUntil: null, marked: true, lastRemindedAt: null, ...extra }
}

/** 一个有 100 个合格成员的群，外加指定的人。 */
function input(mode: Mode, people: Array<[Member, Verdict]>, extra: Partial<PlanInput> = {}): PlanInput {
  const members: Member[] = [member('10000', { role: 'owner' }), member('20000', { role: 'admin' })]
  const verdicts = new Map<string, Verdict>([['10000', verdict('10000', 'allow')], ['20000', verdict('20000', 'allow')]])
  for (let i = 0; i < 100; i++) {
    const qq = String(30000 + i)
    members.push(member(qq))
    verdicts.set(qq, verdict(qq, 'allow', 'OK', `名片${qq}`))
  }
  for (const [m, v] of people) {
    members.push(m)
    verdicts.set(m.qq, v)
  }
  return {
    groupId: '123456789',
    mode,
    held: false,
    bypassBreaker: false,
    partial: false,
    groupSize: members.length,
    members,
    verdicts,
    tracked: new Map(),
    protectedIds: new Set(['99999']),
    botRole: 'admin',
    now: NOW,
    settings: {
      graceMs: 48 * HOUR,
      breakerCount: 5,
      breakerPercent: 10,
      kickBudget: 10,
      syncCards: true,
      markCards: true,
      markPrefix: '【SPY】',
      allowKicks: true,
    },
    ...extra,
  }
}

describe('熔断阈值', () => {
  it('取「人数」和「比例」中较小的，至少为 1', () => {
    expect(breakerThreshold(300, 5, 10)).toBe(5)
    expect(breakerThreshold(30, 5, 10)).toBe(3)
    expect(breakerThreshold(8, 5, 10)).toBe(1)
    expect(breakerThreshold(0, 5, 10)).toBe(1)
  })
})

describe('report 模式', () => {
  it('只报告：不记录宽限、不改名片、不移出', () => {
    const plan = planGroup(input('report', [[member('40001'), verdict('40001', 'deny')]]))
    expect(plan.writes).toBe(false)
    expect(plan.newDenies.map((d) => d.qq)).toEqual(['40001'])
    expect(plan.track).toEqual([])
    expect(plan.cards).toEqual([])
    expect(plan.kicks).toEqual([])
    // 100 个合格成员的名片和 AA 不一致，只计数
    expect(plan.cardsPending).toBe(0)
  })

  it('名片不一致时只计数', () => {
    const data = input('report', [[member('40001', { card: '乱改的' }), verdict('40001', 'allow', 'OK', '[IGC] Kaela Voss - 凯拉')]])
    const plan = planGroup(data)
    expect(plan.cardsPending).toBe(1)
    expect(plan.cards).toEqual([])
  })

  it('从 remind 降级到 report：撤掉标记、清空宽限记录', () => {
    const data = input('report', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark' }])
    expect(plan.untrack).toContain('40001')
    expect(plan.track).toEqual([])
  })
})

describe('remind 模式', () => {
  it('新发现的不合格：记录宽限（无截止时间）、名片加标记、不移出', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: '张三' }), verdict('40001', 'deny')]]))
    expect(plan.writes).toBe(true)
    expect(plan.track).toHaveLength(1)
    expect(plan.track[0]).toMatchObject({ qq: '40001', graceUntil: null, marked: true, reason: 'NOT_BOUND' })
    expect(plan.cards).toEqual([{ qq: '40001', from: '张三', to: '【SPY】张三', why: 'mark' }])
    expect(plan.kicks).toEqual([])
  })

  it('名片为空时用昵称加标记', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: '', nickname: '小明' }), verdict('40001', 'deny')]]))
    expect(plan.cards[0].to).toBe('【SPY】小明')
  })

  it('标记后超过 60 字节时截断，不切断多字节字符', () => {
    const long = '凯'.repeat(30)
    const plan = planGroup(input('remind', [[member('40001', { card: long }), verdict('40001', 'deny')]]))
    const card = plan.cards[0].to
    expect(Buffer.byteLength(card, 'utf8')).toBeLessThanOrEqual(60)
    expect(card.startsWith('【SPY】')).toBe(true)
    expect(card).not.toContain('�')
  })

  it('已经带标记的不再重复加', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.cards).toEqual([])
  })

  it('成员自己去掉了标记：重新加上', () => {
    const data = input('remind', [[member('40001', { card: '张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '40001', from: '张三', to: '【SPY】张三', why: 'mark' }])
  })

  it('从 enforce 降级到 remind：清掉截止时间', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - HOUR) })]])
    const plan = planGroup(data)
    expect(plan.track[0].graceUntil).toBeNull()
    expect(plan.kicks).toEqual([])
  })

  it('关闭标记时不改名片', () => {
    const data = input('remind', [[member('40001'), verdict('40001', 'deny')]])
    data.settings.markCards = false
    const plan = planGroup(data)
    expect(plan.cards).toEqual([])
    expect(plan.track[0].marked).toBe(false)
  })
})

describe('enforce 模式', () => {
  it('新发现的不合格：截止时间 = 现在 + 宽限期，这一轮不移出', () => {
    const plan = planGroup(input('enforce', [[member('40001'), verdict('40001', 'deny')]]))
    expect(plan.track[0].graceUntil?.getTime()).toBe(NOW + 48 * HOUR)
    expect(plan.kicks).toEqual([])
  })

  it('从 remind 升级来的（没有截止时间）：从现在开始算完整的宽限期', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: null })]])
    const plan = planGroup(data)
    expect(plan.track[0].graceUntil?.getTime()).toBe(NOW + 48 * HOUR)
    expect(plan.kicks).toEqual([])
  })

  it('宽限期到了且仍然 deny：移出', () => {
    const data = input('enforce', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([{ qq: '40001', reason: 'NOT_BOUND', name: '【SPY】张三' }])
  })

  it('宽限期还没到：不移出', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW + HOUR) })]])
    expect(planGroup(data).kicks).toEqual([])
  })

  it('每小时上限：超过的推迟', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 4; i++) {
      const qq = String(40001 + i)
      people.push([member(qq), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq, { graceUntil: new Date(NOW - 1) }))
    }
    const data = input('enforce', people)
    data.tracked = rows
    data.settings.kickBudget = 3
    const plan = planGroup(data)
    expect(plan.kicks).toHaveLength(3)
    expect(plan.kicksDeferred).toBe(1)
  })

  it('局部复查（事件、新人、提醒）从不移出', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    data.settings.allowKicks = false
    expect(planGroup(data).kicks).toEqual([])
  })
})

describe('永不处置的人', () => {
  const cases: Array<[string, Member]> = [
    ['群主', member('40001', { role: 'owner' })],
    ['管理员', member('40001', { role: 'admin' })],
    ['QQ 官方机器人', member('40001', { isRobot: true })],
  ]
  for (const [name, m] of cases) {
    it(`${name}判为 deny 也不记录、不改名片、不移出`, () => {
      const data = input('enforce', [[m, verdict('40001', 'deny')]])
      data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
      const plan = planGroup(data)
      expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['40001'])
      expect(plan.kicks).toEqual([])
      expect(plan.track).toEqual([])
      expect(plan.cards.filter((c) => c.qq === '40001')).toEqual([])
    })
  }

  it('白名单和机器人账号判为 deny 也不处置', () => {
    const data = input('enforce', [[member('99999'), verdict('99999', 'deny')]])
    data.tracked = new Map([['99999', tracked('99999', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([])
    expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['99999'])
  })
})

describe('review 与无法判断', () => {
  it('review（例如冲突）：永不处置，取消宽限并撤掉标记', () => {
    const data = input('enforce', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'review', 'CONFLICT')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([])
    expect(plan.untrack).toEqual(['40001'])
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark' }])
    expect(plan.reviews).toEqual([{ qq: '40001', reason: 'CONFLICT' }])
  })

  it('无法判断（unknown）：什么都不改，宽限记录保留，也不移出', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'unknown', 'UNKNOWN')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([])
    expect(plan.untrack).toEqual([])
    expect(plan.track).toEqual([])
    expect(plan.unknowns).toEqual(['40001'])
  })

  it('AA 结果里缺了这个人：当作无法判断', () => {
    const data = input('enforce', [])
    data.members.push(member('40001'))
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([])
    expect(plan.unknowns).toEqual(['40001'])
  })
})

describe('熔断', () => {
  function massDeny(mode: Mode, count: number, extra: Partial<PlanInput> = {}) {
    const people: Array<[Member, Verdict]> = []
    for (let i = 0; i < count; i++) {
      const qq = String(40001 + i)
      people.push([member(qq), verdict(qq, 'deny', 'NO_ACCESS')])
    }
    return planGroup(input(mode, people, extra))
  }

  it('新增不合格不超过阈值：正常处置', () => {
    const plan = massDeny('enforce', 5)
    expect(plan.tripped).toBe(false)
    expect(plan.track).toHaveLength(5)
  })

  it('新增不合格超过阈值：整群这一轮什么都不做', () => {
    const plan = massDeny('enforce', 6)
    expect(plan.tripped).toBe(true)
    expect(plan.writes).toBe(false)
    expect(plan.track).toEqual([])
    expect(plan.cards).toEqual([])
    expect(plan.kicks).toEqual([])
  })

  it('AA 误配置让全群变成 deny：熔断，一个都不动', () => {
    const data = input('enforce', [])
    for (const [qq, v] of data.verdicts) data.verdicts.set(qq, { ...v, decision: 'deny', reason: 'NO_ACCESS', card: null })
    // 另外有一个宽限期已到的人，也不能被移出
    data.members.push(member('40001'))
    data.verdicts.set('40001', verdict('40001', 'deny'))
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.tripped).toBe(true)
    expect(plan.kicks).toEqual([])
    expect(plan.cards).toEqual([])
  })

  it('已经处于熔断状态：不管人数多少都不处置', () => {
    const plan = massDeny('enforce', 1, { held: true })
    expect(plan.tripped).toBe(false)
    expect(plan.writes).toBe(false)
    expect(plan.track).toEqual([])
  })

  it('管理员确认后的一轮：不触发熔断', () => {
    const plan = massDeny('remind', 20, { bypassBreaker: true })
    expect(plan.tripped).toBe(false)
    expect(plan.track).toHaveLength(20)
  })

  it('已经在宽限期里的人不算「新增」，不会每轮都熔断', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 20; i++) {
      const qq = String(40001 + i)
      people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq))
    }
    const plan = planGroup(input('remind', people, { tracked: rows }))
    expect(plan.tripped).toBe(false)
    expect(plan.newDenies).toEqual([])
  })

  it('report 模式不熔断（本来就不处置）', () => {
    expect(massDeny('report', 50).tripped).toBe(false)
  })
})

describe('名片同步', () => {
  it('合格且名片不同：改成 AA 给的名片', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: '乱改的' }), verdict('40001', 'allow', 'OK', '[IGC] Kaela Voss - 凯拉')]]))
    expect(plan.cards).toEqual([{ qq: '40001', from: '乱改的', to: '[IGC] Kaela Voss - 凯拉', why: 'sync' }])
  })

  it('名片相同：不改', () => {
    const plan = planGroup(input('remind', []))
    expect(plan.cards).toEqual([])
  })

  it('AA 没给名片（card 为 null）：不改', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: 'x' }), verdict('40001', 'allow', 'OK', null)]]))
    expect(plan.cards).toEqual([])
  })

  it('被标记过的人变合格：取消宽限，名片改成 AA 的', () => {
    const data = input('enforce', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'allow', 'OK', '[IGC] 张三')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.untrack).toEqual(['40001'])
    expect(plan.kicks).toEqual([])
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '[IGC] 张三', why: 'sync' }])
  })

  it('关闭名片同步时，变合格的人只去掉标记', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'allow', 'OK', '[IGC] 张三')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    data.settings.syncCards = false
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark' }])
  })

  it('机器人只是管理员时，不改群主和其他管理员的名片', () => {
    const data = input('remind', [])
    data.verdicts.set('10000', verdict('10000', 'allow', 'OK', '[IGC] 群主'))
    data.verdicts.set('20000', verdict('20000', 'allow', 'OK', '[IGC] 管理'))
    expect(planGroup(data).cards).toEqual([])
  })

  it('机器人是群主时，可以改管理员的名片', () => {
    const data = input('remind', [], { botRole: 'owner' })
    data.verdicts.set('20000', verdict('20000', 'allow', 'OK', '[IGC] 管理'))
    expect(planGroup(data).cards.map((c) => c.qq)).toEqual(['20000'])
  })

  it('机器人不是管理员：什么都不改', () => {
    const plan = planGroup(input('enforce', [[member('40001'), verdict('40001', 'deny')]], { botRole: 'member' }))
    expect(plan.writes).toBe(false)
    expect(plan.track).toEqual([])
  })
})

describe('离开群的人', () => {
  it('完整巡检：删除已离开的人的宽限记录', () => {
    const data = input('remind', [])
    data.tracked = new Map([['40001', tracked('40001')]])
    expect(planGroup(data).untrack).toEqual(['40001'])
  })

  it('局部复查：不知道谁离开了，不删除', () => {
    const data = input('remind', [], { partial: true })
    data.tracked = new Map([['40001', tracked('40001')]])
    expect(planGroup(data).untrack).toEqual([])
  })
})
