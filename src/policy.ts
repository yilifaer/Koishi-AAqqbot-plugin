// 处置规划：给定群成员、AA 判定和已有的宽限记录，算出这一轮要做的事。
// 这里是纯函数，不碰 QQ 也不碰数据库；真正执行由 guard.ts 完成（执行前还会再实时复核一次）。

import type { Verdict } from './aa'
import type { Mode } from './config'
import type { TrackedMember } from './store'
import { truncateUtf8 } from './util'

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
}

/** 管理员确认后的豁免：不超过报告里看到的人数就不熔断。 */
export interface Bypass {
  maxNew: number
  maxKicks: number
}

export interface PlanInput {
  groupId: string
  /** 生效中的模式（未确认的升级不生效）。 */
  mode: Mode
  /** 这个群已经处于熔断状态。 */
  held: boolean
  bypass: Bypass | null
  /** 截止时间在这个时刻之前的，已经由管理员确认过（不计入「批量移出」熔断）。 */
  kickApprovedBefore: number
  /** members 只是群里的一部分人（事件、新人、提醒）。 */
  partial: boolean
  /** 群的总人数，用来算熔断比例。 */
  groupSize: number
  members: Member[]
  verdicts: Map<string, Verdict>
  tracked: Map<string, TrackedMember>
  /** 这个 Koishi 里的机器人账号 + 白名单。 */
  protectedIds: Set<string>
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
}

export interface KickPlan {
  qq: string
  reason: string
  name: string
}

export interface Plan {
  counts: { members: number; allow: number; deny: number; review: number; unknown: number }
  /** 不受保护、判为 deny 的人。 */
  denies: Array<{ qq: string; reason: string; isNew: boolean }>
  /** 判为 deny 但受保护（群主、管理员、机器人、白名单），永不处置，只报告。 */
  protectedDenies: Array<{ qq: string; reason: string }>
  reviews: Array<{ qq: string; reason: string }>
  unknowns: string[]
  newDenies: Array<{ qq: string; reason: string }>
  threshold: number
  /** 宽限期已到、可以移出的人数（未扣除每小时上限）。 */
  kicksDue: number
  /** 这一轮新触发了熔断。 */
  tripped: boolean
  tripReason: string
  /** 无法判断的人太多，这一轮不改动（R9 ③）。 */
  unknownHeavy: boolean
  /** 这一轮允许改动群（加标记、改名片、移出）。 */
  writes: boolean
  track: TrackedMember[]
  untrack: string[]
  /** 先加/去标记，再同步名片。 */
  cards: CardChange[]
  kicks: KickPlan[]
  kicksDeferred: number
  /** 不允许改动时，本来要同步的名片数（写进报告）。 */
  cardsPending: number
}

export function breakerThreshold(groupSize: number, count: number, percent: number): number {
  return Math.max(1, Math.min(count, Math.floor(groupSize * percent / 100)))
}

/** 只有身份确定是普通成员、不是机器人、不在保护名单里的人才可能被处置。 */
export function isProtected(member: Member, protectedIds: Set<string>): boolean {
  return member.role !== 'member' || member.isRobot || protectedIds.has(member.qq)
}

export function botCanWrite(botRole: Role | null): boolean {
  return botRole === 'owner' || botRole === 'admin'
}

/** 机器人能不能改这个普通成员的名片（群主和管理员都能改普通成员）。 */
export function canEditCard(botRole: Role | null, target: Member): boolean {
  return botCanWrite(botRole) && target.role === 'member'
}

export function markedCard(prefix: string, member: Member): string {
  const base = member.card || member.nickname || member.qq
  return truncateUtf8(prefix + base, CARD_LIMIT_BYTES)
}

export function stripMark(prefix: string, card: string): string {
  return prefix && card.startsWith(prefix) ? card.slice(prefix.length) : card
}

export function planGroup(input: PlanInput): Plan {
  const { settings, mode, now } = input
  const prefix = settings.markPrefix
  const writesMode = mode === 'remind' || mode === 'enforce'
  const plan: Plan = {
    counts: { members: input.members.length, allow: 0, deny: 0, review: 0, unknown: 0 },
    denies: [],
    protectedDenies: [],
    reviews: [],
    unknowns: [],
    newDenies: [],
    threshold: breakerThreshold(input.groupSize, settings.breakerCount, settings.breakerPercent),
    kicksDue: 0,
    tripped: false,
    tripReason: '',
    unknownHeavy: false,
    writes: false,
    track: [],
    untrack: [],
    cards: [],
    kicks: [],
    kicksDeferred: 0,
    cardsPending: 0,
  }

  const allowed: Array<{ member: Member; verdict: Verdict }> = []
  const denied: Array<{ member: Member; verdict: Verdict }> = []
  const settled: Member[] = [] // 已有宽限记录、现在变成合格 / 需人工 / 受保护的人
  const kickable: Array<KickPlan & { deadline: number }> = []
  const present = new Set<string>()

  for (const member of input.members) {
    present.add(member.qq)
    const verdict = input.verdicts.get(member.qq)
    const decision = verdict?.decision ?? 'unknown'
    const record = input.tracked.get(member.qq)
    const prot = isProtected(member, input.protectedIds)
    if (decision === 'allow') {
      plan.counts.allow++
      allowed.push({ member, verdict: verdict! })
      if (record) settled.push(member)
    } else if (decision === 'deny') {
      plan.counts.deny++
      if (prot) {
        plan.protectedDenies.push({ qq: member.qq, reason: verdict!.reason })
        if (record) settled.push(member)
        continue
      }
      plan.denies.push({ qq: member.qq, reason: verdict!.reason, isNew: !record })
      if (!record) plan.newDenies.push({ qq: member.qq, reason: verdict!.reason })
      denied.push({ member, verdict: verdict! })
      // 可以移出：enforce、完整巡检、截止时间已到、并且最近成功提醒过（截止时间是在提醒时定下的）
      const deadline = record?.graceUntil?.getTime()
      const remindedAt = record?.lastRemindedAt?.getTime()
      if (mode === 'enforce' && settings.allowKicks && deadline !== undefined && deadline <= now
        && remindedAt !== undefined && now - remindedAt <= settings.remindFreshMs) {
        kickable.push({ qq: member.qq, reason: verdict!.reason, name: member.card || member.nickname || member.qq, deadline })
      }
    } else if (decision === 'review') {
      // 需要人工处理（例如冲突）：永不处置；已有的宽限记录取消
      plan.counts.review++
      plan.reviews.push({ qq: member.qq, reason: verdict!.reason })
      if (record) settled.push(member)
    } else {
      // 无法判断：什么都不改，宽限记录原样保留
      plan.counts.unknown++
      plan.unknowns.push(member.qq)
    }
  }

  // 已经离开群的人，删除宽限记录（只有完整名单才能判断谁离开了）
  if (!input.partial) {
    for (const qq of input.tracked.keys()) {
      if (!present.has(qq)) plan.untrack.push(qq)
    }
  }

  // 熔断：新发现的不合格太多，或者一次要移出的人太多（没被管理员确认过的）
  plan.kicksDue = kickable.length
  const unapprovedKicks = kickable.filter((k) => k.deadline > input.kickApprovedBefore).length
  const maxNew = Math.max(plan.threshold, input.bypass?.maxNew ?? 0)
  const maxKicks = Math.max(plan.threshold, input.bypass?.maxKicks ?? 0)
  if (writesMode && !input.held) {
    if (plan.newDenies.length > maxNew) {
      plan.tripped = true
      plan.tripReason = `新发现不合格 ${plan.newDenies.length} 人，超过阈值 ${maxNew} 人`
    } else if (unapprovedKicks > maxKicks) {
      plan.tripped = true
      plan.tripReason = `一次有 ${unapprovedKicks} 人到期要移出，超过阈值 ${maxKicks} 人`
    }
  }
  plan.unknownHeavy = plan.unknowns.length > plan.threshold
  plan.writes = writesMode && !input.held && !plan.tripped && !plan.unknownHeavy && botCanWrite(input.botRole)

  if (!plan.writes) {
    // 机器人以后能改的名片里，和 AA 不一致的有多少（写进报告）
    for (const { member, verdict } of allowed) {
      if (settings.syncCards && verdict.card && member.card !== verdict.card && !isProtected(member, input.protectedIds)) plan.cardsPending++
    }
    // 降级到 report 时，撤掉以前加的标记、清空宽限记录（恢复原状）。
    // 其他不能改动的情况（熔断、机器人不是管理员……）保留宽限记录，等能改动时再撤标记，避免标记残留。
    if (mode === 'report' && !input.held && botCanWrite(input.botRole)) {
      for (const member of input.members) {
        const record = input.tracked.get(member.qq)
        if (!record) continue
        if (record.marked && prefix && member.card.startsWith(prefix) && canEditCard(input.botRole, member)) {
          plan.cards.push({ qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark' })
        }
        if (!plan.untrack.includes(member.qq)) plan.untrack.push(member.qq)
      }
    }
    return plan
  }

  // ---- 以下只在允许改动时执行

  const marks: CardChange[] = []
  const syncs: CardChange[] = []

  // 不再需要宽限的人：取消记录，撤掉标记（受保护的人只取消记录，不碰名片）
  for (const member of settled) {
    plan.untrack.push(member.qq)
    const verdict = input.verdicts.get(member.qq)
    const willSync = verdict?.decision === 'allow' && settings.syncCards && !!verdict.card
    if (!willSync && input.tracked.get(member.qq)?.marked && prefix && member.card.startsWith(prefix)
      && !isProtected(member, input.protectedIds) && canEditCard(input.botRole, member)) {
      marks.push({ qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark' })
    }
  }

  // 合格的人：同步名片（受保护的人不改，DECISIONS 第 26 条）
  for (const { member, verdict } of allowed) {
    if (isProtected(member, input.protectedIds) || !canEditCard(input.botRole, member)) continue
    if (settings.syncCards && verdict.card && member.card !== verdict.card) {
      syncs.push({ qq: member.qq, from: member.card, to: verdict.card, why: 'sync' })
    }
  }

  for (const { member, verdict } of denied) {
    const existing = input.tracked.get(member.qq)
    const row: TrackedMember = existing
      ? { ...existing }
      : { groupId: input.groupId, qq: member.qq, reason: verdict.reason, firstDeniedAt: new Date(now), graceUntil: null, marked: false, lastRemindedAt: null }
    row.reason = verdict.reason
    // 截止时间只在 enforce 模式下、第一次成功发出带截止时间的提醒时定下（guard.sendReminder）
    if (mode !== 'enforce') row.graceUntil = null
    if (settings.markCards && prefix) {
      if (member.card.startsWith(prefix)) {
        row.marked = true
      } else if (canEditCard(input.botRole, member)) {
        marks.push({ qq: member.qq, from: member.card, to: markedCard(prefix, member), why: 'mark' })
        row.marked = true
      }
    }
    plan.track.push(row)
  }

  plan.cards = [...marks, ...syncs]
  const budget = Math.max(0, settings.kickBudget)
  plan.kicks = kickable.slice(0, budget).map(({ qq, reason, name }) => ({ qq, reason, name }))
  plan.kicksDeferred = kickable.length - plan.kicks.length
  return plan
}
