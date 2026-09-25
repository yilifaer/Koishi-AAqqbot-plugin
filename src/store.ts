// 插件自己的数据表（表名都带 aaqqbot_ 前缀）。

import type { Context } from 'koishi'
import type { Mode } from './config'

/** 被发现不合格、正在宽限期里的成员。 */
export interface TrackedMember {
  groupId: string
  qq: string
  reason: string
  firstDeniedAt: Date
  /** enforce 模式下的移出截止时间；remind 模式下为 null（只提醒不踢）。 */
  graceUntil: Date | null
  marked: boolean
  lastRemindedAt: Date | null
}

export interface GroupState {
  groupId: string
  /** 管理员确认过的最高模式；升级到 remind / enforce 必须经过确认。 */
  confirmedMode: string
  confirmedAt: Date | null
  confirmedBy: string
  /** 熔断开始的时间；不为 null 表示这个群处于熔断状态。 */
  holdSince: Date | null
  holdNote: string
  /** 管理员最近一次 aaqq.confirm 的时间。截止时间早于它的移出视为已确认。 */
  lastConfirmAt: Date | null
  /** 确认后的豁免：在这个时间之前的下一轮巡检，人数不超过下面两个数就不熔断。 */
  bypassUntil: Date | null
  bypassMaxNew: number
  bypassMaxKicks: number
  /** 最近一轮巡检的「新发现不合格」和「到期要移出」人数（确认时用作豁免上限）。 */
  lastNewDenies: number
  lastKicksDue: number
  lastPatrolAt: Date | null
  lastPatrolOk: boolean
  lastPatrolNote: string
}

interface KvRow {
  key: string
  value: string
}

export interface AuditRow {
  id: number
  at: Date
  action: string
  groupId: string
  qq: string
  detail: string
  actor: string
}

declare module 'koishi' {
  interface Tables {
    aaqqbot_member: TrackedMember
    aaqqbot_group: GroupState
    aaqqbot_kv: KvRow
    aaqqbot_audit: AuditRow
  }
}

export function extendModels(ctx: Context) {
  ctx.model.extend('aaqqbot_member', {
    groupId: { type: 'string', length: 32 },
    qq: { type: 'string', length: 32 },
    reason: { type: 'string', length: 64 },
    firstDeniedAt: 'timestamp',
    graceUntil: { type: 'timestamp', nullable: true },
    marked: 'boolean',
    lastRemindedAt: { type: 'timestamp', nullable: true },
  }, { primary: ['groupId', 'qq'] })

  ctx.model.extend('aaqqbot_group', {
    groupId: { type: 'string', length: 32 },
    confirmedMode: { type: 'string', length: 16 },
    confirmedAt: { type: 'timestamp', nullable: true },
    confirmedBy: { type: 'string', length: 64 },
    holdSince: { type: 'timestamp', nullable: true },
    holdNote: 'text',
    lastConfirmAt: { type: 'timestamp', nullable: true },
    bypassUntil: { type: 'timestamp', nullable: true },
    bypassMaxNew: 'unsigned',
    bypassMaxKicks: 'unsigned',
    lastNewDenies: 'unsigned',
    lastKicksDue: 'unsigned',
    lastPatrolAt: { type: 'timestamp', nullable: true },
    lastPatrolOk: 'boolean',
    lastPatrolNote: 'text',
  }, { primary: 'groupId' })

  ctx.model.extend('aaqqbot_kv', {
    key: { type: 'string', length: 64 },
    value: 'text',
  }, { primary: 'key' })

  ctx.model.extend('aaqqbot_audit', {
    id: 'unsigned',
    at: 'timestamp',
    action: { type: 'string', length: 32 },
    groupId: { type: 'string', length: 32 },
    qq: { type: 'string', length: 32 },
    detail: 'text',
    actor: { type: 'string', length: 64 },
  }, { primary: 'id', autoInc: true })
}

export function defaultGroupState(groupId: string): GroupState {
  return {
    groupId,
    confirmedMode: 'report',
    confirmedAt: null,
    confirmedBy: '',
    holdSince: null,
    holdNote: '',
    lastConfirmAt: null,
    bypassUntil: null,
    bypassMaxNew: 0,
    bypassMaxKicks: 0,
    lastNewDenies: 0,
    lastKicksDue: 0,
    lastPatrolAt: null,
    lastPatrolOk: false,
    lastPatrolNote: '',
  }
}

export class Store {
  constructor(private ctx: Context, private now: () => number = Date.now) {}

  private get db() {
    return this.ctx.database
  }

  async tracked(groupId: string): Promise<Map<string, TrackedMember>> {
    const rows = await this.db.get('aaqqbot_member', { groupId })
    return new Map(rows.map((row) => [row.qq, row]))
  }

  async saveTracked(rows: TrackedMember[]) {
    if (rows.length) await this.db.upsert('aaqqbot_member', rows)
  }

  /** 只更新还存在的记录（不会把刚被删除的人重新写回来）。 */
  async markReminded(groupId: string, rows: Array<Pick<TrackedMember, 'qq' | 'graceUntil' | 'lastRemindedAt'>>) {
    for (const row of rows) {
      await this.db.set('aaqqbot_member', { groupId, qq: row.qq }, { graceUntil: row.graceUntil, lastRemindedAt: row.lastRemindedAt })
    }
  }

  async removeTracked(groupId: string, qqs: string[]) {
    if (qqs.length) await this.db.remove('aaqqbot_member', { groupId, qq: qqs })
  }

  /** 群从 AA 上移除：宽限记录和确认状态都清掉，以后重新加回来要重新确认。 */
  async forgetGroup(groupId: string) {
    await this.db.remove('aaqqbot_member', { groupId })
    await this.db.remove('aaqqbot_group', { groupId })
  }

  async groupState(groupId: string): Promise<GroupState> {
    const [row] = await this.db.get('aaqqbot_group', { groupId })
    return row ?? defaultGroupState(groupId)
  }

  async setGroupState(groupId: string, patch: Partial<GroupState>) {
    const current = await this.groupState(groupId)
    await this.db.upsert('aaqqbot_group', [{ ...current, ...patch, groupId }])
  }

  async getKv<T>(key: string): Promise<T | undefined> {
    const [row] = await this.db.get('aaqqbot_kv', { key })
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  }

  async setKv(key: string, value: unknown) {
    await this.db.upsert('aaqqbot_kv', [{ key, value: JSON.stringify(value) }])
  }

  async audit(action: string, groupId: string, qq: string, detail: string, actor = 'bot') {
    await this.db.create('aaqqbot_audit', { at: new Date(this.now()), action, groupId, qq, detail, actor })
  }

  async countAudit(action: string, groupId: string, since: Date): Promise<number> {
    const rows = await this.db.get('aaqqbot_audit', { action, groupId, at: { $gte: since } }, ['id'])
    return rows.length
  }

  async recentAudit(limit: number): Promise<AuditRow[]> {
    return this.db.select('aaqqbot_audit').orderBy('id', 'desc').limit(limit).execute()
  }

  async pruneAudit(before: Date) {
    await this.db.remove('aaqqbot_audit', { at: { $lt: before } })
  }
}

export function isMode(value: string): value is Mode {
  return value === 'off' || value === 'report' || value === 'remind' || value === 'enforce'
}
