// 处置规划：给定群成员、AA 判定和已有的跟踪记录，算出这一轮要做的事。
// 这里是纯函数，不碰 QQ 也不碰数据库；真正执行由 guard.ts 完成（执行前还会再实时复核一次）。

import type { Verdict } from './aa'
import type { Mode } from './config'
import type { TrackedMember } from './store'
import { cleanName, displayName, truncateUtf8 } from './util'

/** QQ 群名片上限按 60 字节处理（与 AA 端一致，API.md 第 9 节）。 */
export const CARD_LIMIT_BYTES = 60

/** unknown：平台返回的身份认不出来，按受保护处理（R7「角色判不出就跳过」）。 */
export type Role = 'owner' | 'admin' | 'member' | 'unknown'

export interface Member {
  qq: string
  role: Role
  card: string
  nickname: string
  isRobot: boolean
}

export interface PlanSettings {
  breakerCount: number
  breakerPercent: number
  /** 这个群这一小时里还能移出几个人。 */
  kickBudget: number
  syncCards: boolean
  markCards: boolean
  markPrefix: string
  /** 只有完整巡检才允许移出；事件、新人、提醒这些局部复查不移出。 */
  allowKicks: boolean
  /** 移出前多久之内必须成功提醒过（毫秒）。 */
  remindFreshMs: number
  /** 冷静期多长（毫秒）。 */
  cooldownMs: number
  /** 不合格的群主、管理员也加标记、跟踪、提醒（永远不移出，DECISIONS 第 51 条）。 */
  markAdmins?: boolean
  /** 「离开联盟」类原因（AA 的原因码）：一发现就提醒，宽限 fastGraceMs（DECISIONS 第 52 条）。 */
  fastReasons?: Set<string>
  /** 「离开联盟」类原因的宽限时间（毫秒）。 */
  fastGraceMs?: number
}

/** 冷静期：since 开始时间；set 触发它的那批 QQ（null = 0.1.x 留下的熔断，名单未知）。 */
export interface Cooling {
  since: number
  set: Set<string> | null
}

export interface PlanInput {
  groupId: string
  /** 这个群现在的模式（remind / enforce / report；off 用 planRelease）。 */
  mode: Mode
  /** 冷静期状态；不在冷静期为 null。 */
  cooling: Cooling | null
  /**
   * 最近一次冷静期结束的时间。截止时间早于它的到期移出、在它之前（含）开始处置的人，都算「经过冷静期批准」，
   * 不再计入熔断。
   */
  releasedBefore: number
  /** 最近 cooldownMs 内已经执行、没经过冷静期批准的移出人数（按时间窗口累计，DECISIONS 第 46 条）。只在完整巡检里给。 */
  recentUnapprovedKicks?: number
  /** members 只是群里的一部分人（事件、新人、提醒），或者名单可能不完整。 */
  partial: boolean
  /** 群的总人数，用来算熔断阈值。 */
  groupSize: number
  members: Member[]
  verdicts: Map<string, Verdict>
  tracked: Map<string, TrackedMember>
  /** 机器人账号 + 白名单：永不提醒、永不加标记、永不移出、永不改名片。 */
  protectedIds: Set<string>
  /** 机器人账号：整个跳过，不计数、不列出。 */
  selfIds: Set<string>
  /** 被 QQ 拒过的管理员名片（QQ → 那张 AA 名片）：同一张名片不再重试。 */
  refusedCards: Map<string, string>
  /** 机器人在这个群里的身份；不是群主或管理员时什么都改不了。 */
  botRole: Role | null
  now: number
  settings: PlanSettings
}

export interface CardChange {
  qq: string
  from: string
  to: string
  why: 'sync' | 'mark' | 'unmark'
  /** 群主或管理员的名片（K1）。 */
  admin?: boolean
  /** 改成功后删掉这个人的跟踪记录（撤标记要等 QQ 确认改成功后才落库）。 */
  untrackAfter?: boolean
}

export interface KickPlan {
  qq: string
  reason: string
  name: string
}

export type BreakerState = 'none' | 'trip' | 'cooling' | 'release' | 'restart'

export interface Plan {
  /** 统计不含机器人自己。 */
  counts: { members: number; allow: number; deny: number; review: number; unknown: number }
  /**
   * 要处置的、判为 deny 的人（isNew：上一轮还没有记录）。
   * staff：群主 / 管理员（markAdmins 打开时）——加标记、提醒，但永远不移出。
   */
  denies: Array<{ qq: string; reason: string; isNew: boolean; staff?: 'owner' | 'admin' }>
  /** 判为 deny 但受保护（白名单、机器人；markAdmins 关掉时还有群主、管理员），不处置，只报告。 */
  protectedDenies: Array<{ qq: string; reason: string }>
  reviews: Array<{ qq: string; reason: string }>
  unknowns: string[]
  /** 报告里的「新发现不合格」：上一轮还没有记录的人。 */
  newDenies: Array<{ qq: string; reason: string; staff?: 'owner' | 'admin' }>
  /** 这一轮第一次要被处置的人（没有记录，或记录还没处置过）：熔断按它计数。 */
  firstActions: Array<{ qq: string; reason: string }>
  threshold: number
  /** 宽限期已到、可以移出的人数（未扣除每小时上限）。 */
  kicksDue: number
  breaker: BreakerState
  breakerReason: string
  /** 触发熔断的那批 QQ（第一次处置的人 ∪ 未确认的到期移出）。 */
  breakerSet: string[]
  /** 冷静结束判断时，和冷静开始时相比多出来的人数。 */
  breakerAdded: number
  /** 冷静期结束时，截止时间已过、但最近 36 小时没提醒过的人：截止时间清空，重新提醒后再算宽限期。 */
  regraced: number
  /** 无法判断的人太多，这一轮不改动（R9 ③）。 */
  unknownHeavy: boolean
  /** remind / enforce 下机器人不是群主或管理员：本群不做任何改动。 */
  noRole: boolean
  /** 这一轮允许改动群（加标记、改名片、移出）。 */
  writes: boolean
  track: TrackedMember[]
  untrack: string[]
  /** 先加 / 去标记，再同步名片。 */
  cards: CardChange[]
  kicks: KickPlan[]
  kicksDeferred: number
  /** 不允许改动时，本来要同步的名片数（写进报告）。 */
  cardsPending: number
  /** 改不了的群主 / 管理员名片（K1）：同一张名片被 QQ 拒过（不再重试），或者机器人身份不够。 */
  adminCardsBlocked: Array<{ qq: string; to: string }>
  /**
   * 「离开联盟」的人：这一轮要马上发提醒（不等每日提醒，DECISIONS 第 52 条）。
   * 只给单独离开的人；因为人太多触发过冷静期、冷静期结束时放行的那一批，照旧每日提醒、普通宽限期。
   */
  fastRemind: TrackedMember[]
}

export function breakerThreshold(groupSize: number, count: number, percent: number): number {
  return Math.max(1, Math.min(count, Math.floor(groupSize * percent / 100)))
}

/** 只有身份确定是普通成员、不是机器人、不在保护名单里的人才可能被处置。 */
export function isProtected(member: Member, protectedIds: Set<string>): boolean {
  return member.role !== 'member' || member.isRobot || protectedIds.has(member.qq)
}

/**
 * 群主或管理员，并且不是 QQ 官方机器人、不是机器人账号、不在白名单里。
 * markAdmins 打开时他们不合格也加标记、提醒，但永远不移出（DECISIONS 第 51 条）。
 */
export function isStaff(member: Member, protectedIds: Set<string>): boolean {
  return (member.role === 'owner' || member.role === 'admin') && !member.isRobot && !protectedIds.has(member.qq)
}

/** 完全不碰的人：受保护，并且不是「要加标记的群主 / 管理员」。 */
export function isExempt(member: Member, protectedIds: Set<string>, markAdmins: boolean): boolean {
  return isProtected(member, protectedIds) && !(markAdmins && isStaff(member, protectedIds))
}

export function botCanWrite(botRole: Role | null): boolean {
  return botRole === 'owner' || botRole === 'admin'
}

/** 标记 / 撤标记：机器人（群主或管理员）只动普通成员。 */
export function canEditCard(botRole: Role | null, target: Member): boolean {
  return botCanWrite(botRole) && target.role === 'member'
}

/** 名片同步的对象：普通成员 / 群主或管理员 / 不碰。机器人账号和白名单在 protectedIds 里。 */
export function syncKind(member: Member, protectedIds: Set<string>): 'member' | 'admin' | null {
  if (member.isRobot || protectedIds.has(member.qq)) return null
  if (member.role === 'member') return 'member'
  if (member.role === 'admin' || member.role === 'owner') return 'admin'
  return null
}

/**
 * 机器人能不能改这个人的名片：机器人是群主或管理员时，普通成员、管理员、群主的都能改
 * （所有者实测：机器人只是管理员时也能改群主和其他管理员的名片，DECISIONS 第 44 条）。
 * QQ 真的拒绝时由 applyPlan 记下来，同一张名片不再重试。
 */
export function canSetCard(botRole: Role | null, target: Member): boolean {
  return botCanWrite(botRole) && (target.role === 'member' || target.role === 'admin' || target.role === 'owner')
}

export function markedCard(prefix: string, member: Member): string {
  const base = cleanName(member.card) ? member.card : cleanName(member.nickname) ? member.nickname : member.qq
  return truncateUtf8(prefix + base, CARD_LIMIT_BYTES)
}

export function stripMark(prefix: string, card: string): string {
  return prefix && card.startsWith(prefix) ? card.slice(prefix.length) : card
}

/** 撤标记。群主 / 管理员的带上 admin，QQ 拒绝时会在运维群列出来。 */
function unmarkChange(member: Member, prefix: string, untrackAfter: boolean): CardChange {
  return {
    qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark', untrackAfter,
    ...(member.role === 'member' ? {} : { admin: true }),
  }
}

function newRecord(groupId: string, qq: string, reason: string, now: number): TrackedMember {
  return { groupId, qq, reason, firstDeniedAt: new Date(now), graceUntil: null, marked: false, lastRemindedAt: null, activeSince: null }
}

/**
 * 熔断 / 冷静期状态（K3）。
 * - 不在冷静期：超过阈值 → trip。
 * - 冷静中：局部复查、名单可疑、无法判断太多 → 保持；已经不超过阈值 → 立即结束（所有者 Q7）；
 *   仍超过阈值但没到时间 → 保持；到时间后：还是那批人 → 结束，变化大 → 重新冷静。
 * - 机器人不是群主或管理员：本来就改不了，不进也不出冷静期。
 */
export function breakerState(
  writesMode: boolean, canWrite: boolean, cooling: Cooling | null, partial: boolean, unknownHeavy: boolean,
  now: number, cooldownMs: number, over: boolean, set: Set<string>, threshold: number,
): { state: BreakerState; added: number } {
  if (!writesMode) return { state: 'none', added: 0 }
  if (!canWrite) return { state: cooling ? 'cooling' : 'none', added: 0 }
  if (!cooling) return { state: over ? 'trip' : 'none', added: 0 }
  if (partial || unknownHeavy) return { state: 'cooling', added: 0 }
  if (!over) return { state: 'release', added: 0 }
  if (now - cooling.since < cooldownMs) return { state: 'cooling', added: 0 }
  if (cooling.set === null) return { state: 'restart', added: set.size }
  const added = [...set].filter((qq) => !cooling.set!.has(qq)).length
  return { state: added <= threshold ? 'release' : 'restart', added }
}

export function planGroup(input: PlanInput): Plan {
  const { settings, mode, now } = input
  const prefix = settings.markPrefix
  const writesMode = mode === 'remind' || mode === 'enforce'
  const plan: Plan = {
    counts: { members: 0, allow: 0, deny: 0, review: 0, unknown: 0 },
    denies: [],
    protectedDenies: [],
    reviews: [],
    unknowns: [],
    newDenies: [],
    firstActions: [],
    threshold: breakerThreshold(input.groupSize, settings.breakerCount, settings.breakerPercent),
    kicksDue: 0,
    breaker: 'none',
    breakerReason: '',
    breakerSet: [],
    breakerAdded: 0,
    regraced: 0,
    unknownHeavy: false,
    noRole: writesMode && !botCanWrite(input.botRole),
    writes: false,
    track: [],
    untrack: [],
    cards: [],
    kicks: [],
    kicksDeferred: 0,
    cardsPending: 0,
    adminCardsBlocked: [],
    fastRemind: [],
  }

  const allowed: Array<{ member: Member; verdict: Verdict }> = []
  const denied: Array<{ member: Member; verdict: Verdict }> = []
  const settled: Member[] = [] // 有跟踪记录、现在合格 / 需人工 / 受保护的人
  const kickable: Array<KickPlan & { deadline: number }> = []
  /** 截止时间已到的人（不管最近有没有提醒过）：熔断按它计数（DECISIONS 第 48 条）。 */
  const due: Array<{ qq: string; deadline: number; fresh: boolean }> = []
  const present = new Set<string>()

  for (const member of input.members) {
    present.add(member.qq)
    const record = input.tracked.get(member.qq)
    if (input.selfIds.has(member.qq)) {
      // 机器人自己：不计数、不列出、不改名片；以前的跟踪记录删掉（K6）
      if (record) plan.untrack.push(member.qq)
      continue
    }
    plan.counts.members++
    const verdict = input.verdicts.get(member.qq)
    const decision = verdict?.decision ?? 'unknown'
    const prot = isProtected(member, input.protectedIds)
    if (decision === 'allow') {
      plan.counts.allow++
      allowed.push({ member, verdict: verdict! })
      if (record) settled.push(member)
    } else if (decision === 'deny') {
      plan.counts.deny++
      if (isExempt(member, input.protectedIds, !!settings.markAdmins)) {
        plan.protectedDenies.push({ qq: member.qq, reason: verdict!.reason })
        if (record) settled.push(member)
        continue
      }
      // 普通成员，或者 markAdmins 打开时的群主 / 管理员（prot 为真，永远不移出）
      const staff = prot ? { staff: member.role as 'owner' | 'admin' } : {}
      plan.denies.push({ qq: member.qq, reason: verdict!.reason, isNew: !record, ...staff })
      if (!record) plan.newDenies.push({ qq: member.qq, reason: verdict!.reason, ...staff })
      if (!record || !record.activeSince) plan.firstActions.push({ qq: member.qq, reason: verdict!.reason })
      denied.push({ member, verdict: verdict! })
      // 可以移出：enforce、完整巡检、截止时间已到、并且最近成功提醒过（截止时间是在提醒时定下的）
      const deadline = record?.graceUntil?.getTime()
      const remindedAt = record?.lastRemindedAt?.getTime()
      if (!prot && mode === 'enforce' && settings.allowKicks && deadline !== undefined && deadline <= now) {
        const fresh = remindedAt !== undefined && now - remindedAt <= settings.remindFreshMs
        due.push({ qq: member.qq, deadline, fresh })
        if (fresh) {
          const name = displayName(member.card, member.nickname, prefix) || member.qq
          kickable.push({ qq: member.qq, reason: verdict!.reason, name, deadline })
        }
      }
    } else if (decision === 'review') {
      // 需要人工处理（例如冲突）：永不处置；已有的跟踪记录取消
      plan.counts.review++
      plan.reviews.push({ qq: member.qq, reason: verdict!.reason })
      if (record) settled.push(member)
    } else {
      // 无法判断：什么都不改，跟踪记录原样保留
      plan.counts.unknown++
      plan.unknowns.push(member.qq)
    }
  }

  // 已经离开群的人，删除跟踪记录（只有完整名单才能判断谁离开了）
  if (!input.partial) {
    for (const qq of input.tracked.keys()) {
      if (!present.has(qq)) plan.untrack.push(qq)
    }
  }

  // ---- 熔断 / 冷静期（K3）：按时间窗口累计（DECISIONS 第 46 条）
  // 任何一段 cooldownMs 长的时间里，没经过冷静期就开始处置的人、没经过冷静期批准就移出的人，都不超过阈值。
  // 分几次事件陆续到达的不合格成员，每次都不超过阈值也会被累计起来。
  plan.kicksDue = kickable.length
  const hours = Math.round(settings.cooldownMs / 3600_000)
  const settledQqs = new Set(settled.map((m) => m.qq))
  // 冷静中时，窗口固定在冷静开始的那一刻（不跟着时间往前滑）：只有真的有人变回合格，计数才会下降（DECISIONS 第 53 条）
  const windowEnd = input.cooling ? input.cooling.since : now
  const recentActive = [...input.tracked.values()].filter((row) => {
    const at = row.activeSince?.getTime()
    return at !== undefined && at > windowEnd - settings.cooldownMs && at <= now && at > input.releasedBefore
      && !settledQqs.has(row.qq) && !input.selfIds.has(row.qq)
  })
  const dueUnapproved = due.filter((k) => k.deadline > input.releasedBefore)
  const recentKicks = input.recentUnapprovedKicks ?? 0
  const newCount = plan.firstActions.length + recentActive.length
  const kickCount = dueUnapproved.length + recentKicks
  const overNew = plan.firstActions.length > 0 && newCount > plan.threshold
  const overKicks = dueUnapproved.length > 0 && kickCount > plan.threshold
  const set = new Set([...plan.firstActions.map((x) => x.qq), ...dueUnapproved.map((x) => x.qq), ...recentActive.map((r) => r.qq)])
  plan.unknownHeavy = plan.unknowns.length > plan.threshold
  const breaker = breakerState(writesMode, botCanWrite(input.botRole), input.cooling, input.partial, plan.unknownHeavy,
    now, settings.cooldownMs, overNew || overKicks, set, plan.threshold)
  plan.breaker = breaker.state
  plan.breakerAdded = breaker.added
  plan.breakerSet = [...set]
  plan.breakerReason = overNew
    ? recentActive.length
      ? `最近 ${hours} 小时内要开始处置的不合格成员有 ${newCount} 人（这一轮 ${plan.firstActions.length} 人、之前 ${recentActive.length} 人，超过阈值 ${plan.threshold} 人）`
      : `要开始处置的不合格成员有 ${newCount} 人（超过阈值 ${plan.threshold} 人）`
    : overKicks
      ? recentKicks
        ? `最近 ${hours} 小时内到期要移出的有 ${kickCount} 人（这一轮 ${dueUnapproved.length} 人、已经移出 ${recentKicks} 人，超过阈值 ${plan.threshold} 人）`
        : `一次有 ${dueUnapproved.length} 人到期要移出（超过阈值 ${plan.threshold} 人）`
      : ''
  plan.writes = writesMode && (plan.breaker === 'none' || plan.breaker === 'release')
    && !plan.unknownHeavy && botCanWrite(input.botRole)

  // ---- 名片同步（K1）：任何模式都算，只有 writes 时真正改
  const syncs: CardChange[] = []
  for (const { member, verdict } of allowed) {
    if (!(settings.syncCards && verdict.card && member.card !== verdict.card)) continue
    const kind = syncKind(member, input.protectedIds)
    if (kind === 'member') {
      if (plan.writes) {
        if (canEditCard(input.botRole, member)) syncs.push({ qq: member.qq, from: member.card, to: verdict.card, why: 'sync' })
      } else {
        plan.cardsPending++
      }
    } else if (kind === 'admin' && botCanWrite(input.botRole)) {
      // 机器人是普通成员时：不改、不列
      if (canSetCard(input.botRole, member) && input.refusedCards.get(member.qq) !== verdict.card) {
        if (plan.writes) syncs.push({ qq: member.qq, from: member.card, to: verdict.card, why: 'sync', admin: true })
        else plan.cardsPending++
      } else {
        plan.adminCardsBlocked.push({ qq: member.qq, to: verdict.card })
      }
    }
  }

  if (!plan.writes) {
    if (mode === 'report') planReport(input, plan)
    else planRecordOnly(input, plan, denied)
    return plan
  }

  // ---- 以下只在允许改动时执行
  const marks: CardChange[] = []

  // 不再需要跟踪的人：要撤标记的等 QQ 改成功后再删记录（untrackAfter），其余直接删。
  // 受保护的人（例如被加标记之后才当上管理员）身上的标记也撤掉（DECISIONS 第 49 条）。
  for (const member of settled) {
    const record = input.tracked.get(member.qq)!
    const hasMark = record.marked && !!prefix && member.card.startsWith(prefix)
    const sync = syncs.find((s) => s.qq === member.qq)
    if (hasMark && sync) {
      sync.untrackAfter = true // AA 名片会覆盖掉标记
    } else if (hasMark && canSetCard(input.botRole, member)) {
      marks.push(unmarkChange(member, prefix, true))
    } else {
      plan.untrack.push(member.qq)
    }
  }
  const staleDue = new Set(due.filter((k) => !k.fresh).map((k) => k.qq))
  const fastReasons = settings.fastReasons ?? new Set<string>()
  const fastGraceMs = settings.fastGraceMs ?? 2 * 3600_000

  for (const { member, verdict } of denied) {
    const existing = input.tracked.get(member.qq)
    const row: TrackedMember = existing ? { ...existing } : newRecord(input.groupId, member.qq, verdict.reason, now)
    row.reason = verdict.reason
    row.activeSince = existing?.activeSince ?? new Date(now)
    // 群主 / 管理员：加标记、提醒，但永远没有截止时间、永远不移出
    const staff = isProtected(member, input.protectedIds)
    // 截止时间只在 enforce 模式下、第一次成功发出带截止时间的提醒时定下（guard.sendReminder）
    if (mode !== 'enforce' || staff) row.graceUntil = null
    // 冷静期结束时，截止时间已过、但冷静中没有提醒过的人：重新提醒后再算宽限期（DECISIONS 第 48 条）
    if (plan.breaker === 'release' && staleDue.has(member.qq) && row.graceUntil) {
      row.graceUntil = null
      plan.regraced++
    }
    if (settings.markCards && prefix) {
      if (member.card.startsWith(prefix)) {
        row.marked = true
      } else if (staff ? canSetCard(input.botRole, member) : canEditCard(input.botRole, member)) {
        const to = markedCard(prefix, member)
        if (staff && input.refusedCards.get(member.qq) === to) {
          // 这张标记名片被 QQ 拒过：不再重试，运维群列一次（DECISIONS 第 55 条）
          plan.adminCardsBlocked.push({ qq: member.qq, to })
        } else {
          // marked 等 QQ 确认改成功后才写（applyPlan）
          marks.push({ qq: member.qq, from: member.card, to, why: 'mark', ...(staff ? { admin: true } : {}) })
        }
        row.marked = false
      }
    }
    // 「离开联盟」：单独离开的人马上提醒（冷静期结束时放行的那一批、以前冷静期批准过的人，走普通流程）
    const approved = plan.breaker === 'release' || (!!existing?.activeSince && existing.activeSince.getTime() <= input.releasedBefore)
    if (!staff && !approved && fastReasons.has(verdict.reason)) {
      const needs = mode === 'enforce'
        ? row.graceUntil === null || row.graceUntil.getTime() > now + fastGraceMs // 还没定过、或者定的是更晚的普通截止时间
        : !existing?.activeSince || !fastReasons.has(existing.reason) // remind：刚开始处置，或者原因刚变成离开联盟
      if (needs) plan.fastRemind.push(row)
    }
    plan.track.push(row)
  }

  plan.cards = [...marks, ...syncs]
  const budget = Math.max(0, settings.kickBudget)
  plan.kicks = kickable.slice(0, budget).map(({ qq, reason, name }) => ({ qq, reason, name }))
  plan.kicksDeferred = kickable.length - plan.kicks.length
  return plan
}

/**
 * report 模式（K4）：只记录不合格的人（不提醒、不加标记、不移出），并撤掉以前加的标记。
 * marked 保持「名片上现在还有没有标记」，撤标记成功后才由 applyPlan 改成 false 或删行。
 */
function planReport(input: PlanInput, plan: Plan) {
  const prefix = input.settings.markPrefix
  for (const member of input.members) {
    if (input.selfIds.has(member.qq)) continue // 机器人自己的旧记录已经在主循环里放进 untrack
    const record = input.tracked.get(member.qq)
    const verdict = input.verdicts.get(member.qq)
    const decision = verdict?.decision ?? 'unknown'
    // markAdmins 打开时，不合格的群主 / 管理员和普通成员一样只记录（DECISIONS 第 51 条）
    const prot = isExempt(member, input.protectedIds, !!input.settings.markAdmins)
    const marked = !!record?.marked && !!prefix && member.card.startsWith(prefix)
    const keep = (decision === 'deny' && !prot) || (!!record && decision === 'unknown') // 这一行要留着（只记录）
    // 受保护的人身上的标记也撤（DECISIONS 第 49 条）
    if (marked && canSetCard(input.botRole, member)) plan.cards.push(unmarkChange(member, prefix, !keep))
    if (decision === 'deny' && !prot) {
      plan.track.push({
        ...(record ?? newRecord(input.groupId, member.qq, verdict!.reason, input.now)),
        reason: verdict!.reason, graceUntil: null, activeSince: null, marked,
      })
    } else if (record) {
      if (decision === 'unknown') plan.track.push({ ...record, graceUntil: null, activeSince: null, marked })
      else if (marked && (!prot || canSetCard(input.botRole, member))) {
        /* 还有标记：记录留着，撤成功后 applyPlan 删（untrackAfter）；机器人改不了就下一轮再试 */
      } else plan.untrack.push(member.qq)
    }
  }
}

/**
 * remind / enforce 下不能改动的轮次（冷静中、无法判断太多、机器人不是管理员）：
 * 新出现的不合格只记录一行（activeSince = null，不提醒、不加标记、不移出）；已有的行只更新原因。
 */
function planRecordOnly(input: PlanInput, plan: Plan, denied: Array<{ member: Member; verdict: Verdict }>) {
  for (const { member, verdict } of denied) {
    const existing = input.tracked.get(member.qq)
    plan.track.push(existing ? { ...existing, reason: verdict.reason } : newRecord(input.groupId, member.qq, verdict.reason, input.now))
  }
}

/**
 * 群改成 off：撤掉以前加的标记，删掉在场的人的跟踪记录（名单可能不完整，不在名单里的人不动）。
 * 要撤标记的人：记录先留着，撤标记的 CardChange 带 untrackAfter，QQ 改成功后 applyPlan 再删。
 * 机器人不是群主或管理员时什么都不做（记录留到能撤标记为止）。
 */
export function planRelease(
  members: Member[], tracked: Map<string, TrackedMember>, protectedIds: Set<string>, botRole: Role | null, prefix: string,
): { cards: CardChange[]; untrack: string[] } {
  const cards: CardChange[] = []
  const untrack: string[] = []
  if (!botCanWrite(botRole)) return { cards, untrack }
  for (const member of members) {
    const record = tracked.get(member.qq)
    if (!record) continue
    const hasMark = record.marked && !!prefix && member.card.startsWith(prefix)
    if (hasMark && canSetCard(botRole, member)) {
      cards.push(unmarkChange(member, prefix, true))
    } else {
      untrack.push(member.qq)
    }
  }
  return { cards, untrack }
}

/** 一个空的规划（off 清理用）。 */
export function emptyPlan(): Plan {
  return {
    counts: { members: 0, allow: 0, deny: 0, review: 0, unknown: 0 },
    denies: [], protectedDenies: [], reviews: [], unknowns: [], newDenies: [], firstActions: [],
    threshold: 1, kicksDue: 0, breaker: 'none', breakerReason: '', breakerSet: [], breakerAdded: 0, regraced: 0,
    unknownHeavy: false, noRole: false, writes: false, track: [], untrack: [], cards: [], kicks: [],
    kicksDeferred: 0, cardsPending: 0, adminCardsBlocked: [], fastRemind: [],
  }
}
