import { describe, expect, it } from 'vitest'
import type { Verdict } from '../src/aa'
import type { Mode } from '../src/config'
import { breakerThreshold, markedCard, Member, PlanInput, planGroup, planRelease } from '../src/policy'
import type { TrackedMember } from '../src/store'

const NOW = Date.parse('2026-09-25T12:00:00+08:00')
const HOUR = 3600_000
const BOT = '88888'

function member(qq: string, extra: Partial<Member> = {}): Member {
  return { qq, role: 'member', card: `名片${qq}`, nickname: `昵称${qq}`, isRobot: false, ...extra }
}

function verdict(qq: string, decision: Verdict['decision'], reason = decision === 'allow' ? 'OK' : 'NOT_BOUND', card: string | null = null): Verdict {
  return { qq, decision, reason, card: decision === 'allow' ? card : null }
}

function tracked(qq: string, extra: Partial<TrackedMember> = {}): TrackedMember {
  return {
    groupId: '123456789', qq, reason: 'NOT_BOUND', firstDeniedAt: new Date(NOW - 72 * HOUR), graceUntil: null, marked: true,
    lastRemindedAt: new Date(NOW - 10 * HOUR), activeSince: new Date(NOW - 72 * HOUR), ...extra,
  }
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
    cooling: null,
    releasedBefore: 0,
    partial: false,
    groupSize: members.length,
    members,
    verdicts,
    tracked: new Map(),
    protectedIds: new Set(['99999', BOT]),
    selfIds: new Set([BOT]),
    refusedCards: new Map(),
    botRole: 'admin',
    now: NOW,
    settings: {
      remindFreshMs: 36 * HOUR,
      breakerCount: 5,
      breakerPercent: 10,
      kickBudget: 10,
      syncCards: true,
      markCards: true,
      markPrefix: '【SPY】',
      allowKicks: true,
      cooldownMs: 6 * HOUR,
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
  it('只报告：记住报过的人（只记录，不处置），不改名片、不移出', () => {
    const plan = planGroup(input('report', [[member('40001'), verdict('40001', 'deny')]]))
    expect(plan.writes).toBe(false)
    expect(plan.newDenies.map((d) => d.qq)).toEqual(['40001'])
    expect(plan.track).toHaveLength(1)
    expect(plan.track[0]).toMatchObject({ qq: '40001', activeSince: null, graceUntil: null, marked: false, firstDeniedAt: new Date(NOW) })
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

  it('第二轮还是同一个人：不再算「新发现」', () => {
    const data = input('report', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { activeSince: null, marked: false })]])
    const plan = planGroup(data)
    expect(plan.newDenies).toEqual([])
    expect(plan.denies).toEqual([{ qq: '40001', reason: 'NOT_BOUND', isNew: false }])
  })

  it('从 remind 降级到 report：撤掉标记，记录保留（撤成功后才把 marked 改成 false）', () => {
    const data = input('report', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW + HOUR) })]])
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: false }])
    expect(plan.untrack).not.toContain('40001')
    expect(plan.track).toHaveLength(1)
    expect(plan.track[0]).toMatchObject({ qq: '40001', activeSince: null, graceUntil: null, marked: true })
    expect(plan.newDenies).toEqual([])
  })

  it('合格了的人：没有标记就删记录；有标记就等撤成功后再删', () => {
    const data = input('report', [
      [member('40001'), verdict('40001', 'allow', 'OK', '名片40001')],
      [member('40002', { card: '【SPY】李四' }), verdict('40002', 'allow', 'OK', '[IGC] 李四')],
    ])
    data.tracked = new Map([['40001', tracked('40001', { marked: false })], ['40002', tracked('40002')]])
    const plan = planGroup(data)
    expect(plan.untrack).toEqual(['40001'])
    expect(plan.cards).toEqual([{ qq: '40002', from: '【SPY】李四', to: '李四', why: 'unmark', untrackAfter: true }])
    expect(plan.track).toEqual([])
  })

  it('无法判断的人：记录保留', () => {
    const data = input('report', [[member('40001'), verdict('40001', 'unknown', 'UNKNOWN')]])
    data.tracked = new Map([['40001', tracked('40001', { marked: false })]])
    const plan = planGroup(data)
    expect(plan.untrack).toEqual([])
    expect(plan.track.map((r) => [r.qq, r.activeSince])).toEqual([['40001', null]])
  })
})

describe('remind 模式', () => {
  it('新发现的不合格：记录宽限（无截止时间）、名片加标记、不移出', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: '张三' }), verdict('40001', 'deny')]]))
    expect(plan.writes).toBe(true)
    expect(plan.track).toHaveLength(1)
    expect(plan.track[0]).toMatchObject({ qq: '40001', graceUntil: null, marked: true, reason: 'NOT_BOUND', activeSince: new Date(NOW) })
    expect(plan.firstActions).toEqual([{ qq: '40001', reason: 'NOT_BOUND' }])
    expect(plan.cards).toEqual([{ qq: '40001', from: '张三', to: '【SPY】张三', why: 'mark' }])
    expect(plan.kicks).toEqual([])
  })

  it('已处置过的人：activeSince 不变，不算第一次处置', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.track[0].activeSince).toEqual(new Date(NOW - 72 * HOUR))
    expect(plan.firstActions).toEqual([])
  })

  it('只记录过的人（report 时记下的）：这一轮开始处置，activeSince = 现在', () => {
    const data = input('remind', [[member('40001', { card: '张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { activeSince: null, marked: false })]])
    const plan = planGroup(data)
    expect(plan.newDenies).toEqual([])
    expect(plan.firstActions).toEqual([{ qq: '40001', reason: 'NOT_BOUND' }])
    expect(plan.track[0].activeSince).toEqual(new Date(NOW))
  })

  it('名片为空时用昵称加标记', () => {
    const plan = planGroup(input('remind', [[member('40001', { card: '', nickname: '小明' }), verdict('40001', 'deny')]]))
    expect(plan.cards[0].to).toBe('【SPY】小明')
  })

  it('名片只有空格或看不见的字符时用昵称加标记', () => {
    const blank = ' ' + String.fromCodePoint(0x200b, 0x3164) + '\u3000'
    expect(markedCard('【SPY】', member('40001', { card: blank, nickname: '小明' }))).toBe('【SPY】小明')
    expect(markedCard('【SPY】', member('40001', { card: blank, nickname: ' ' }))).toBe('【SPY】40001')
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
  it('新发现的不合格：先不定截止时间（第一次成功提醒时才定），这一轮不移出', () => {
    const plan = planGroup(input('enforce', [[member('40001'), verdict('40001', 'deny')]]))
    expect(plan.track[0].graceUntil).toBeNull()
    expect(plan.kicks).toEqual([])
  })

  it('从 remind 升级来的（没有截止时间）：截止时间仍然等提醒时再定', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: null })]])
    const plan = planGroup(data)
    expect(plan.track[0].graceUntil).toBeNull()
    expect(plan.kicks).toEqual([])
  })

  it('截止时间已到，但 36 小时内没有成功提醒过（例如冷静期、暂停期间）：不移出', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1), lastRemindedAt: new Date(NOW - 72 * HOUR) })]])
    expect(planGroup(data).kicks).toEqual([])
  })

  it('截止时间已到，但从没提醒过：不移出', () => {
    const data = input('enforce', [[member('40001'), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1), lastRemindedAt: null })]])
    expect(planGroup(data).kicks).toEqual([])
  })

  it('宽限期到了、最近提醒过、仍然 deny：移出', () => {
    const data = input('enforce', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([{ qq: '40001', reason: 'NOT_BOUND', name: '张三' }])
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
    // 记录等撤标记成功后再删
    expect(plan.untrack).toEqual([])
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: true }])
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

describe('冷静期（熔断）', () => {
  function massDeny(mode: Mode, count: number, extra: Partial<PlanInput> = {}) {
    const people: Array<[Member, Verdict]> = []
    for (let i = 0; i < count; i++) {
      const qq = String(40001 + i)
      people.push([member(qq), verdict(qq, 'deny', 'NO_ACCESS')])
    }
    return planGroup(input(mode, people, extra))
  }
  const firstSix = () => new Set(Array.from({ length: 6 }, (_, i) => String(40001 + i)))

  it('要开始处置的人不超过阈值：正常处置', () => {
    const plan = massDeny('enforce', 5)
    expect(plan.breaker).toBe('none')
    expect(plan.track).toHaveLength(5)
  })

  it('超过阈值：trip，这一轮只记录（不加标记、不移出）', () => {
    const plan = massDeny('enforce', 6)
    expect(plan.breaker).toBe('trip')
    expect(plan.breakerReason).toBe('要开始处置的不合格成员有 6 人（超过阈值 5 人）')
    expect(plan.breakerSet.sort()).toEqual([...firstSix()].sort())
    expect(plan.writes).toBe(false)
    expect(plan.track).toHaveLength(6)
    expect(plan.track.every((r) => r.activeSince === null && !r.marked)).toBe(true)
    expect(plan.cards).toEqual([])
    expect(plan.kicks).toEqual([])
  })

  it('AA 误配置让全群变成 deny：trip，一个都不动', () => {
    const data = input('enforce', [])
    for (const [qq, v] of data.verdicts) data.verdicts.set(qq, { ...v, decision: 'deny', reason: 'NO_ACCESS', card: null })
    // 另外有一个宽限期已到的人，也不能被移出
    data.members.push(member('40001'))
    data.verdicts.set('40001', verdict('40001', 'deny'))
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.breaker).toBe('trip')
    expect(plan.kicks).toEqual([])
    expect(plan.cards).toEqual([])
  })

  it('冷静中、仍超过阈值、还没到时间：cooling，什么都不改', () => {
    const plan = massDeny('enforce', 6, { cooling: { since: NOW - HOUR, set: firstSix() } })
    expect(plan.breaker).toBe('cooling')
    expect(plan.writes).toBe(false)
    expect(plan.cards).toEqual([])
  })

  it('冷静中的局部复查、无法判断太多：即使到了时间也保持 cooling', () => {
    const cooling = { since: NOW - 7 * HOUR, set: firstSix() }
    expect(massDeny('enforce', 6, { cooling, partial: true }).breaker).toBe('cooling')
    const people: Array<[Member, Verdict]> = []
    for (let i = 0; i < 6; i++) people.push([member(String(40001 + i)), verdict(String(40001 + i), 'deny', 'NO_ACCESS')])
    for (let i = 0; i < 6; i++) people.push([member(String(41001 + i)), verdict(String(41001 + i), 'unknown', 'UNKNOWN')])
    const plan = planGroup(input('enforce', people, { cooling }))
    expect(plan.unknownHeavy).toBe(true)
    expect(plan.breaker).toBe('cooling')
  })

  it('冷静满 6 小时、还是同一批人：release，正常处置', () => {
    const plan = massDeny('enforce', 6, { cooling: { since: NOW - 6 * HOUR, set: firstSix() } })
    expect(plan.breaker).toBe('release')
    expect(plan.writes).toBe(true)
    expect(plan.cards).toHaveLength(6)
  })

  it('已经不超过阈值（AA 改回来了）：冷静才 1 小时也立即 release', () => {
    const plan = massDeny('enforce', 2, { cooling: { since: NOW - HOUR, set: firstSix() } })
    expect(plan.breaker).toBe('release')
    expect(plan.breakerReason).toBe('')
    expect(plan.writes).toBe(true)
  })

  it('已经不超过阈值，但这一轮是局部复查或无法判断太多：仍然 cooling', () => {
    expect(massDeny('enforce', 2, { cooling: { since: NOW - HOUR, set: firstSix() }, partial: true }).breaker).toBe('cooling')
    const people: Array<[Member, Verdict]> = []
    for (let i = 0; i < 6; i++) people.push([member(String(41001 + i)), verdict(String(41001 + i), 'unknown', 'UNKNOWN')])
    expect(planGroup(input('enforce', people, { cooling: { since: NOW - HOUR, set: firstSix() } })).breaker).toBe('cooling')
  })

  it('冷静满时间后多了超过阈值的人：restart', () => {
    const plan = massDeny('enforce', 12, { cooling: { since: NOW - 6 * HOUR, set: firstSix() } })
    expect(plan.breaker).toBe('restart')
    expect(plan.breakerAdded).toBe(6)
    expect(plan.writes).toBe(false)
    expect(plan.breakerSet).toHaveLength(12)
  })

  it('多出来的人不超过阈值：release', () => {
    const plan = massDeny('enforce', 11, { cooling: { since: NOW - 6 * HOUR, set: firstSix() } })
    expect(plan.breaker).toBe('release')
    expect(plan.breakerAdded).toBe(5)
  })

  it('0.1.x 留下的熔断（名单未知）：到时间后仍超过阈值 → restart', () => {
    const plan = massDeny('enforce', 6, { cooling: { since: NOW - 6 * HOUR, set: null } })
    expect(plan.breaker).toBe('restart')
    expect(plan.breakerAdded).toBe(6)
  })

  it('一次到期要移出的人太多：trip，一个都不移出；上次冷静结束之前到期的不计数', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 6; i++) {
      const qq = String(40001 + i)
      people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq, { graceUntil: new Date(NOW - 1) }))
    }
    const plan = planGroup(input('enforce', people, { tracked: rows }))
    expect(plan.breaker).toBe('trip')
    expect(plan.breakerReason).toContain('到期要移出')
    expect(plan.kicks).toEqual([])
    // 冷静期结束（releasedBefore）晚于这些截止时间：不再计数，按每小时上限移出
    const released = planGroup(input('enforce', people, { tracked: rows, releasedBefore: NOW }))
    expect(released.breaker).toBe('none')
    expect(released.kicks).toHaveLength(6)
  })

  it('冷静期间：合格了的人保留记录，等能改动时再撤标记（避免标记残留）', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'allow', 'OK', '[IGC] 张三')]],
      { cooling: { since: NOW - HOUR, set: firstSix() }, partial: true })
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.breaker).toBe('cooling')
    expect(plan.untrack).toEqual([])
    expect(plan.cards).toEqual([])
  })

  it('无法判断的人太多：这一轮不做任何改动，新出现的不合格只记录', () => {
    const people: Array<[Member, Verdict]> = []
    for (let i = 0; i < 6; i++) {
      const qq = String(40001 + i)
      people.push([member(qq), verdict(qq, 'unknown', 'UNKNOWN')])
    }
    people.push([member('40100'), verdict('40100', 'deny')])
    const plan = planGroup(input('remind', people))
    expect(plan.unknownHeavy).toBe(true)
    expect(plan.writes).toBe(false)
    expect(plan.cards).toEqual([])
    expect(plan.track.map((r) => [r.qq, r.activeSince])).toEqual([['40100', null]])
  })

  it('已经处置过的人不算「第一次处置」，不会每轮都 trip', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 20; i++) {
      const qq = String(40001 + i)
      people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq))
    }
    const plan = planGroup(input('remind', people, { tracked: rows }))
    expect(plan.breaker).toBe('none')
    expect(plan.newDenies).toEqual([])
  })

  it('report 时记下的人（只记录）升级后算第一次处置：超过阈值先冷静（Q1）', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 20; i++) {
      const qq = String(40001 + i)
      people.push([member(qq), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq, { activeSince: null, marked: false }))
    }
    const plan = planGroup(input('remind', people, { tracked: rows }))
    expect(plan.newDenies).toEqual([])
    expect(plan.breaker).toBe('trip')
    expect(plan.track.every((r) => r.activeSince === null)).toBe(true)
  })

  it('report 模式永远不进冷静期（本来就不处置）', () => {
    expect(massDeny('report', 50).breaker).toBe('none')
    expect(massDeny('report', 50, { cooling: { since: NOW - 7 * HOUR, set: null } }).breaker).toBe('none')
  })

  it('机器人不是群主或管理员：超过阈值也不进冷静期；已经在冷静期就保持', () => {
    const plan = massDeny('enforce', 20, { botRole: 'member' })
    expect(plan.breaker).toBe('none')
    expect(plan.noRole).toBe(true)
    expect(plan.writes).toBe(false)
    const cooling = massDeny('enforce', 20, { botRole: 'member', cooling: { since: NOW - 7 * HOUR, set: firstSix() } })
    expect(cooling.breaker).toBe('cooling')
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
    // AA 名片会覆盖掉标记；改成功后再删记录
    expect(plan.untrack).toEqual([])
    expect(plan.kicks).toEqual([])
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '[IGC] 张三', why: 'sync', untrackAfter: true }])
  })

  it('关闭名片同步时，变合格的人只去掉标记', () => {
    const data = input('remind', [[member('40001', { card: '【SPY】张三' }), verdict('40001', 'allow', 'OK', '[IGC] 张三')]])
    data.tracked = new Map([['40001', tracked('40001')]])
    data.settings.syncCards = false
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: true }])
  })

  it('机器人只是管理员时，群主和其他管理员的名片也改（所有者实测，DECISIONS 第 44 条）', () => {
    const data = input('remind', [])
    data.verdicts.set('10000', verdict('10000', 'allow', 'OK', '[IGC] 群主'))
    data.verdicts.set('20000', verdict('20000', 'allow', 'OK', '[IGC] 管理'))
    const plan = planGroup(data)
    expect(plan.cards).toEqual([
      { qq: '10000', from: '名片10000', to: '[IGC] 群主', why: 'sync', admin: true },
      { qq: '20000', from: '名片20000', to: '[IGC] 管理', why: 'sync', admin: true },
    ])
    expect(plan.adminCardsBlocked).toEqual([])
  })

  it('机器人是群主：管理员的名片也改；白名单的永远不改', () => {
    const data = input('remind', [[member('99999', { card: 'x' }), verdict('99999', 'allow', 'OK', '[IGC] 白名单')]], { botRole: 'owner' })
    data.verdicts.set('20000', verdict('20000', 'allow', 'OK', '[IGC] 管理'))
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '20000', from: '名片20000', to: '[IGC] 管理', why: 'sync', admin: true }])
    expect(plan.adminCardsBlocked).toEqual([])
  })

  it('身份认不出来（unknown）的成员：按受保护处理', () => {
    const data = input('enforce', [[member('40001', { role: 'unknown' }), verdict('40001', 'deny')]])
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1) })]])
    const plan = planGroup(data)
    expect(plan.kicks).toEqual([])
    expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['40001'])
    // 已有的宽限记录取消
    expect(plan.untrack).toEqual(['40001'])
  })

  it('机器人自己的身份认不出来：什么都不改', () => {
    const plan = planGroup(input('remind', [[member('40001'), verdict('40001', 'deny')]], { botRole: 'unknown' }))
    expect(plan.writes).toBe(false)
  })

  it('机器人不是管理员：什么都不改，只记录', () => {
    const plan = planGroup(input('enforce', [[member('40001'), verdict('40001', 'deny')]], { botRole: 'member' }))
    expect(plan.writes).toBe(false)
    expect(plan.noRole).toBe(true)
    expect(plan.cards).toEqual([])
    expect(plan.track.map((r) => [r.qq, r.activeSince])).toEqual([['40001', null]])
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

describe('群主、管理员的名片（K1）', () => {
  function withAdminCard(extra: Partial<PlanInput> = {}, mode: Mode = 'remind') {
    const data = input(mode, [], extra)
    data.verdicts.set('20000', verdict('20000', 'allow', 'OK', '[IGC] 管理'))
    return data
  }

  it('机器人是群主：管理员名片进 cards（admin）', () => {
    const plan = planGroup(withAdminCard({ botRole: 'owner' }))
    expect(plan.cards).toEqual([{ qq: '20000', from: '名片20000', to: '[IGC] 管理', why: 'sync', admin: true }])
  })

  it('机器人是管理员：管理员名片也进 cards（admin）', () => {
    const plan = planGroup(withAdminCard())
    expect(plan.cards).toEqual([{ qq: '20000', from: '名片20000', to: '[IGC] 管理', why: 'sync', admin: true }])
    expect(plan.adminCardsBlocked).toEqual([])
  })

  it('机器人是普通成员：不改也不列', () => {
    const plan = planGroup(withAdminCard({ botRole: 'member' }))
    expect(plan.adminCardsBlocked).toEqual([])
    expect(plan.cards).toEqual([])
  })

  it('同一张名片被 QQ 拒过：不再重试，列进 adminCardsBlocked；AA 名片变了就再试', () => {
    for (const botRole of ['owner', 'admin'] as const) {
      const same = planGroup(withAdminCard({ botRole, refusedCards: new Map([['20000', '[IGC] 管理']]) }))
      expect(same.cards).toEqual([])
      expect(same.adminCardsBlocked).toEqual([{ qq: '20000', to: '[IGC] 管理' }])
      const changed = planGroup(withAdminCard({ botRole, refusedCards: new Map([['20000', '[IGC] 旧名片']]) }))
      expect(changed.cards.map((c) => c.qq)).toEqual(['20000'])
      expect(changed.adminCardsBlocked).toEqual([])
    }
  })

  it('白名单、机器人自己、QQ 官方机器人、身份认不出来的：两边都没有', () => {
    const people: Array<[Member, Verdict]> = [
      [member('99999', { role: 'admin' }), verdict('99999', 'allow', 'OK', '[IGC] 白名单')],
      [member(BOT, { role: 'admin' }), verdict(BOT, 'allow', 'OK', '[IGC] 机器人')],
      [member('40001', { role: 'admin', isRobot: true }), verdict('40001', 'allow', 'OK', '[IGC] 官方机器人')],
      [member('40002', { role: 'unknown' }), verdict('40002', 'allow', 'OK', '[IGC] 不知道')],
    ]
    for (const botRole of ['owner', 'admin'] as const) {
      const plan = planGroup(input('remind', people, { botRole }))
      expect(plan.cards).toEqual([])
      expect(plan.adminCardsBlocked).toEqual([])
    }
  })

  it('report 模式、机器人是群主：只计入「名片不一致」，不改', () => {
    const plan = planGroup(withAdminCard({ botRole: 'owner' }, 'report'))
    expect(plan.cards).toEqual([])
    expect(plan.cardsPending).toBe(1)
  })

  it('report 模式、机器人是管理员：只计入「名片不一致」，不改也不列', () => {
    const plan = planGroup(withAdminCard({}, 'report'))
    expect(plan.cards).toEqual([])
    expect(plan.adminCardsBlocked).toEqual([])
    expect(plan.cardsPending).toBe(1)
  })

  it('关掉名片同步：管理员也不改、不列', () => {
    const data = withAdminCard({ botRole: 'admin' })
    data.settings.syncCards = false
    const plan = planGroup(data)
    expect(plan.adminCardsBlocked).toEqual([])
    expect(plan.cards).toEqual([])
  })

  it('判 deny 的管理员：只进「不合格但受保护」，不加标记', () => {
    const plan = planGroup(input('enforce', [[member('40001', { role: 'admin' }), verdict('40001', 'deny')]], { botRole: 'owner' }))
    expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['40001'])
    expect(plan.cards).toEqual([])
    expect(plan.track).toEqual([])
  })
})

describe('机器人自己（K6）', () => {
  it('判 deny 也不计数、不列出', () => {
    const plan = planGroup(input('enforce', [[member(BOT, { role: 'admin' }), verdict(BOT, 'deny')]]))
    expect(plan.counts.deny).toBe(0)
    expect(plan.counts.members).toBe(102)
    expect(plan.protectedDenies).toEqual([])
    expect(plan.denies).toEqual([])
    expect(plan.firstActions).toEqual([])
  })

  it('以前留下的跟踪记录删掉（report 模式也一样）', () => {
    for (const mode of ['remind', 'report'] as const) {
      const data = input(mode, [[member(BOT, { role: 'admin' }), verdict(BOT, 'deny')]], { partial: true })
      data.tracked = new Map([[BOT, tracked(BOT)]])
      const plan = planGroup(data)
      expect(plan.untrack).toEqual([BOT])
      expect(plan.track).toEqual([])
    }
  })
})

describe('改成 off（planRelease）', () => {
  const members = [
    member('40001', { card: '【SPY】张三' }),
    member('40002', { card: '李四' }),
    member('40003', { role: 'admin', card: '【SPY】王五' }),
  ]
  const rows = new Map([
    ['40001', tracked('40001')],
    ['40002', tracked('40002')],
    ['40003', tracked('40003')],
    ['40009', tracked('40009')], // 不在名单里：不动
  ])

  it('有标记的撤标记（改成功后才删记录，管理员身上的也撤），其余在场的人直接删记录', () => {
    const result = planRelease(members, rows, new Set(), 'admin', '【SPY】')
    expect(result.cards).toEqual([
      { qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: true },
      { qq: '40003', from: '【SPY】王五', to: '王五', why: 'unmark', untrackAfter: true, admin: true },
    ])
    expect(result.untrack).toEqual(['40002'])
  })

  it('机器人不是群主或管理员：什么都不做', () => {
    expect(planRelease(members, rows, new Set(), 'member', '【SPY】')).toEqual({ cards: [], untrack: [] })
  })
})

describe('熔断按时间窗口累计（0.2.1 P1 / P3）', () => {
  /** 3 个这一轮新出现的不合格 + 若干以前的跟踪记录。阈值 5。 */
  function batch(rows: Array<[string, Partial<TrackedMember>]>, extra: Partial<PlanInput> = {}) {
    const people: Array<[Member, Verdict]> = []
    for (const qq of ['41001', '41002', '41003']) people.push([member(qq), verdict(qq, 'deny')])
    for (const [qq] of rows) people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
    return planGroup(input('remind', people, { tracked: new Map(rows.map(([qq, row]) => [qq, tracked(qq, row)])), ...extra }))
  }
  const recent = (qq: string, hoursAgo = 1): [string, Partial<TrackedMember>] => [qq, { activeSince: new Date(NOW - hoursAgo * HOUR) }]

  it('最近 6 小时内已经开始处置的人也计数：3 + 3 > 5 → trip，breakerSet 包括之前那 3 人', () => {
    const plan = batch([recent('40001'), recent('40002'), recent('40003')])
    expect(plan.breaker).toBe('trip')
    expect(plan.breakerReason).toBe('最近 6 小时内要开始处置的不合格成员有 6 人（这一轮 3 人、之前 3 人，超过阈值 5 人）')
    expect(plan.breakerSet.sort()).toEqual(['40001', '40002', '40003', '41001', '41002', '41003'])
    expect(plan.cards).toEqual([])
  })

  it('窗口外的（7 小时前）、经过冷静期批准的（不晚于上次冷静结束）、已经合格的，都不计数', () => {
    expect(batch([recent('40001', 7), recent('40002', 7), recent('40003', 7)]).breaker).toBe('none')
    expect(batch([recent('40001'), recent('40002'), recent('40003')], { releasedBefore: NOW - HOUR }).breaker).toBe('none')
    const data = input('remind', [
      [member('41001'), verdict('41001', 'deny')], [member('41002'), verdict('41002', 'deny')], [member('41003'), verdict('41003', 'deny')],
      [member('40001'), verdict('40001', 'allow', 'OK', '名片40001')], [member('40002'), verdict('40002', 'allow', 'OK', '名片40002')],
      [member('40003'), verdict('40003', 'allow', 'OK', '名片40003')],
    ])
    data.tracked = new Map(['40001', '40002', '40003'].map((qq) => [qq, tracked(qq, { activeSince: new Date(NOW - HOUR) })]))
    expect(planGroup(data).breaker).toBe('none')
  })

  it('这一轮没有新的人要处置：窗口里的人再多也不 trip', () => {
    const rows = ['40001', '40002', '40003', '40004', '40005', '40006'].map((qq) => recent(qq))
    const people: Array<[Member, Verdict]> = rows.map(([qq]) => [member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
    const plan = planGroup(input('remind', people, { tracked: new Map(rows.map(([qq, row]) => [qq, tracked(qq, row)])) }))
    expect(plan.breaker).toBe('none')
  })

  it('移出也按窗口累计：这一轮到期 3 人 + 最近已经移出 3 人 > 5 → trip，0 移出；没人到期时不 trip', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (const qq of ['40001', '40002', '40003']) {
      people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq, { graceUntil: new Date(NOW - 1) }))
    }
    const plan = planGroup(input('enforce', people, { tracked: rows, recentUnapprovedKicks: 3 }))
    expect(plan.breaker).toBe('trip')
    expect(plan.breakerReason).toBe('最近 6 小时内到期要移出的有 6 人（这一轮 3 人、已经移出 3 人，超过阈值 5 人）')
    expect(plan.kicks).toEqual([])
    expect(planGroup(input('enforce', [], { recentUnapprovedKicks: 5 })).breaker).toBe('none')
  })

  it('到期但最近没提醒过的人也计入熔断（P3）；冷静结束时清空他们的截止时间', () => {
    const people: Array<[Member, Verdict]> = []
    const rows = new Map<string, TrackedMember>()
    for (let i = 0; i < 6; i++) {
      const qq = String(40001 + i)
      people.push([member(qq, { card: `【SPY】${qq}` }), verdict(qq, 'deny')])
      rows.set(qq, tracked(qq, { graceUntil: new Date(NOW - 50 * HOUR), lastRemindedAt: new Date(NOW - 41 * HOUR) }))
    }
    const tripped = planGroup(input('enforce', people, { tracked: rows }))
    expect(tripped.breaker).toBe('trip')
    expect(tripped.kicks).toEqual([])
    const released = planGroup(input('enforce', people, { tracked: rows, cooling: { since: NOW - 40 * HOUR, set: new Set(rows.keys()) } }))
    expect(released.breaker).toBe('release')
    expect(released.regraced).toBe(6)
    expect(released.track.every((r) => r.graceUntil === null)).toBe(true)
    expect(released.kicks).toEqual([])
  })
})

describe('受保护的人身上残留的标记（0.2.1 P4）', () => {
  it('管理员身上有标记：机器人是群主或管理员就撤掉（撤成功后删记录）', () => {
    for (const botRole of ['owner', 'admin'] as const) {
      const data = input('enforce', [[member('40001', { role: 'admin', card: '【SPY】张三' }), verdict('40001', 'deny')]], { botRole })
      data.tracked = new Map([['40001', tracked('40001')]])
      const plan = planGroup(data)
      expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: true, admin: true }])
      expect(plan.untrack).toEqual([])
    }
  })

  it('report 模式也撤；白名单的人身上的也撤', () => {
    const data = input('report', [
      [member('40001', { role: 'admin', card: '【SPY】张三' }), verdict('40001', 'deny')],
      [member('99999', { card: '【SPY】白名单' }), verdict('99999', 'deny')],
    ])
    data.tracked = new Map([['40001', tracked('40001')], ['99999', tracked('99999')]])
    const plan = planGroup(data)
    expect(plan.cards.map((c) => [c.qq, c.to, c.untrackAfter])).toEqual([['40001', '张三', true], ['99999', '白名单', true]])
    expect(plan.untrack).toEqual([])
  })
})

describe('不合格的群主、管理员也加标记（0.2.2，markAdmins）', () => {
  it('打开时：管理员进 denies（staff）、加标记、算第一次处置；enforce 下永远没有截止时间、永远不移出', () => {
    const data = input('enforce', [[member('40001', { role: 'admin', card: '张三' }), verdict('40001', 'deny')]])
    data.settings.markAdmins = true
    data.tracked = new Map([['40001', tracked('40001', { graceUntil: new Date(NOW - 1), marked: false })]])
    const plan = planGroup(data)
    expect(plan.denies).toEqual([{ qq: '40001', reason: 'NOT_BOUND', isNew: false, staff: 'admin' }])
    expect(plan.protectedDenies).toEqual([])
    expect(plan.cards).toEqual([{ qq: '40001', from: '张三', to: '【SPY】张三', why: 'mark' }])
    expect(plan.track[0]).toMatchObject({ qq: '40001', graceUntil: null, marked: true })
    expect(plan.kicks).toEqual([])
    expect(plan.kicksDue).toBe(0)
  })

  it('打开时：白名单、QQ 官方机器人、机器人自己照样完全不碰', () => {
    const data = input('remind', [
      [member('99999', { role: 'admin' }), verdict('99999', 'deny')],
      [member('40001', { role: 'admin', isRobot: true }), verdict('40001', 'deny')],
      [member(BOT, { role: 'admin' }), verdict(BOT, 'deny')],
    ])
    data.settings.markAdmins = true
    const plan = planGroup(data)
    expect(plan.denies).toEqual([])
    expect(plan.cards).toEqual([])
    expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['99999', '40001'])
  })

  it('机器人只是管理员时，也给不合格的群主加标记', () => {
    const data = input('remind', [])
    data.settings.markAdmins = true
    data.verdicts.set('10000', verdict('10000', 'deny'))
    const plan = planGroup(data)
    expect(plan.cards).toEqual([{ qq: '10000', from: '名片10000', to: '【SPY】名片10000', why: 'mark' }])
    expect(plan.denies[0].staff).toBe('owner')
  })

  it('关掉时：和以前一样只报告，已有的标记撤掉', () => {
    const data = input('remind', [[member('40001', { role: 'admin', card: '【SPY】张三' }), verdict('40001', 'deny')]])
    data.settings.markAdmins = false
    data.tracked = new Map([['40001', tracked('40001')]])
    const plan = planGroup(data)
    expect(plan.protectedDenies.map((d) => d.qq)).toEqual(['40001'])
    expect(plan.cards).toEqual([{ qq: '40001', from: '【SPY】张三', to: '张三', why: 'unmark', untrackAfter: true, admin: true }])
  })
})
