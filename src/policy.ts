// 处置规划：给定群成员、AA 判定和已有的宽限记录，算出这一轮要做的事。
// 这里是纯函数，不碰 QQ 也不碰数据库；真正执行由 guard.ts 完成（执行前还会再实时复核一次）。

import type { Verdict } from './aa'
import type { Mode } from './config'
import type { TrackedMember } from './store'
import { truncateUtf8 } from './util'

/** QQ 群名片上限按 60 字节处理（与 AA 端一致，API.md 第 9 节）。 */
export const CARD_LIMIT_BYTES = 60

export type Role = 'owner' | 'admin' | 'member'

export interface Member {
  qq: string
  role: Role
  card: string
  nickname: string
  isRobot: boolean
}

export interface PlanSettings {
  graceMs: number
  breakerCount: number
  breakerPercent: number
  /** 这个群这一小时里还能移出几个人。 */
  kickBudget: number
  syncCards: boolean
  markCards: boolean
  markPrefix: string
  /** 只有完整巡检才允许移出；事件、新人、提醒这些局部复查不移出。 */
  allowKicks: boolean
}

export interface PlanInput {
  groupId: string
  /** 生效中的模式（未确认的升级已经降成 report）。 */
  mode: Mode
  /** 这个群已经处于熔断状态。 */
  held: boolean
  /** 管理员确认过，这一轮不触发熔断。 */
  bypassBreaker: boolean
  /** members 只是群里的一部分人（事件、新人、提醒）。 */
  partial: boolean
  /** 群的总人数，用来算熔断比例。 */
  groupSize: number
  members: Member[]
  verdicts: Map<string, Verdict>
  tracked: Map<string, TrackedMember>
  /** 机器人自己、其他机器人账号、白名单。 */
  protectedIds: Set<string>
  /** 机器人在这个群里的身份；不是管理员时什么都改不了。 */
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
  /** 这一轮新触发了熔断。 */
  tripped: boolean
  /** 这一轮允许改动群（加标记、改名片、移出）。 */
  writes: boolean
  track: TrackedMember[]
  untrack: string[]
  cards: CardChange[]
  kicks: KickPlan[]
  kicksDeferred: number
  /** 不允许改动时，本来要同步的名片数（写进报告）。 */
  cardsPending: number
}

export function breakerThreshold(groupSize: number, count: number, percent: number): number {
  return Math.max(1, Math.min(count, Math.floor(groupSize * percent / 100)))
}

export function isProtected(member: Member, protectedIds: Set<string>): boolean {
  return member.role !== 'member' || member.isRobot || protectedIds.has(member.qq)
}

/** 机器人能不能改这个人的名片：群主能改除自己外的所有人，管理员只能改普通成员。 */
export function canEditCard(botRole: Role | null, target: Member): boolean {
  if (botRole === 'owner') return target.role !== 'owner'
  if (botRole === 'admin') return target.role === 'member'
  return false
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
    tripped: false,
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
  const reviewed: Member[] = []
  const present = new Set<string>()

  for (const member of input.members) {
    present.add(member.qq)
    const verdict = input.verdicts.get(member.qq)
    const decision = verdict?.decision ?? 'unknown'
    if (decision === 'allow') {
      plan.counts.allow++
      allowed.push({ member, verdict: verdict! })
      if (input.tracked.has(member.qq)) plan.untrack.push(member.qq)
    } else if (decision === 'deny') {
      plan.counts.deny++
      if (isProtected(member, input.protectedIds)) {
        plan.protectedDenies.push({ qq: member.qq, reason: verdict!.reason })
      } else {
        const isNew = !input.tracked.has(member.qq)
        plan.denies.push({ qq: member.qq, reason: verdict!.reason, isNew })
        if (isNew) plan.newDenies.push({ qq: member.qq, reason: verdict!.reason })
        denied.push({ member, verdict: verdict! })
      }
    } else if (decision === 'review') {
      // 需要人工处理（例如冲突）：永不处置；已有的宽限记录取消
      plan.counts.review++
      plan.reviews.push({ qq: member.qq, reason: verdict!.reason })
      if (input.tracked.has(member.qq)) {
        plan.untrack.push(member.qq)
        reviewed.push(member)
      }
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

  plan.tripped = writesMode && !input.held && !input.bypassBreaker && plan.newDenies.length > plan.threshold
  plan.writes = writesMode && !input.held && !plan.tripped && input.botRole !== null && input.botRole !== 'member'

  if (!plan.writes) {
    // 机器人以后能改的名片里，和 AA 不一致的有多少（写进报告）
    const editorRole: Role | null = input.botRole === 'owner' || input.botRole === 'admin' ? input.botRole : 'admin'
    for (const { member, verdict } of allowed) {
      if (settings.syncCards && verdict.card && member.card !== verdict.card && canEditCard(editorRole, member)) plan.cardsPending++
    }
    // 降级到 report 时，撤掉以前加的标记、清空宽限记录（恢复原状）
    if (mode === 'report' && !input.held && canWriteAtAll(input.botRole)) {
      for (const member of input.members) {
        const record = input.tracked.get(member.qq)
        if (!record) continue
        if (record.marked && member.card.startsWith(prefix) && prefix && canEditCard(input.botRole, member)) {
          plan.cards.push({ qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark' })
        }
        if (!plan.untrack.includes(member.qq)) plan.untrack.push(member.qq)
      }
    }
    return plan
  }

  // ---- 以下只在允许改动时执行

  for (const { member, verdict } of allowed) {
    if (!canEditCard(input.botRole, member)) continue
    if (settings.syncCards && verdict.card) {
      if (member.card !== verdict.card) plan.cards.push({ qq: member.qq, from: member.card, to: verdict.card, why: 'sync' })
    } else if (input.tracked.get(member.qq)?.marked && prefix && member.card.startsWith(prefix)) {
      plan.cards.push({ qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark' })
    }
  }

  for (const member of reviewed) {
    if (input.tracked.get(member.qq)?.marked && prefix && member.card.startsWith(prefix) && canEditCard(input.botRole, member)) {
      plan.cards.push({ qq: member.qq, from: member.card, to: stripMark(prefix, member.card), why: 'unmark' })
    }
  }

  const kickable: KickPlan[] = []
  for (const { member, verdict } of denied) {
    const existing = input.tracked.get(member.qq)
    const row: TrackedMember = existing
      ? { ...existing }
      : { groupId: input.groupId, qq: member.qq, reason: verdict.reason, firstDeniedAt: new Date(now), graceUntil: null, marked: false, lastRemindedAt: null }
    row.reason = verdict.reason
    if (mode === 'enforce') {
      // 截止时间从进入 enforce 后第一次发现时开始算，保证每个人都有完整的宽限期
      if (!row.graceUntil) row.graceUntil = new Date(now + settings.graceMs)
    } else {
      row.graceUntil = null
    }
    if (settings.markCards && prefix) {
      if (member.card.startsWith(prefix)) {
        row.marked = true
      } else if (canEditCard(input.botRole, member)) {
        plan.cards.push({ qq: member.qq, from: member.card, to: markedCard(prefix, member), why: 'mark' })
        row.marked = true
      }
    }
    plan.track.push(row)
    if (mode === 'enforce' && settings.allowKicks && existing?.graceUntil && existing.graceUntil.getTime() <= now) {
      kickable.push({ qq: member.qq, reason: verdict.reason, name: member.card || member.nickname || member.qq })
    }
  }

  const budget = Math.max(0, settings.kickBudget)
  plan.kicks = kickable.slice(0, budget)
  plan.kicksDeferred = kickable.length - plan.kicks.length
  return plan
}

function canWriteAtAll(botRole: Role | null) {
  return botRole === 'owner' || botRole === 'admin'
}
