// 插件自己的数据表（表名都带 aaqqbot_ 前缀）。
//
// Koishi 的数据库层看到新字段会自动加列，但不会删列、不支持改列名。
// 所以 0.2.0 起不再使用的旧字段仍然声明（注释里写明），新字段都给默认值，读取时再补一次默认值。

import type { Context } from 'koishi'
import type { Mode } from './config'

/** 被发现不合格的成员（report 模式下只记录；remind / enforce 下还会被处置）。 */
export interface TrackedMember {
  groupId: string
  qq: string
  reason: string
  firstDeniedAt: Date
  /** enforce 模式下的移出截止时间；第一次成功发出带截止时间的提醒时才定下。其他情况为 null。 */
  graceUntil: Date | null
  /** 名片上现在有没有机器人加的标记。 */
  marked: boolean
  lastRemindedAt: Date | null
  /** 第一次在 remind / enforce 下被处置（加标记或进入提醒名单）的时间；只记录、还没处置过的人为 null。 */
  activeSince: Date | null
}

export interface GroupState {
  groupId: string
  /** 0.2.0 起不用（模式改了直接生效）。只在 lastMode 为空时读一次，当作「上一个模式」。 */
  confirmedMode: string
  /** 0.2.0 起不用，保留兼容旧数据。 */
  confirmedAt: Date | null
  /** 0.2.0 起不用，保留兼容旧数据。 */
  confirmedBy: string
  /** 冷静期开始的时间；不为 null 表示这个群在冷静期。 */
  holdSince: Date | null
  /** 冷静期的原因。 */
  holdNote: string
  /** 冷静期开始时触发它的那批 QQ（JSON 数组）。空字符串且 holdSince 不为空 = 0.1.x 留下的熔断，名单未知。 */
  holdSet: string
  /** 最近一次冷静期结束的时间。截止时间早于它的到期移出不再计入熔断。 */
  lastConfirmAt: Date | null
  /** 0.2.0 起不用，保留兼容旧数据。 */
  bypassUntil: Date | null
  /** 0.2.0 起不用，保留兼容旧数据。 */
  bypassMaxNew: number
  /** 0.2.0 起不用，保留兼容旧数据。 */
  bypassMaxKicks: number
  /** 0.2.0 起不用，保留兼容旧数据。 */
  lastNewDenies: number
  /** 0.2.0 起不用，保留兼容旧数据。 */
  lastKicksDue: number
  /** 上一次被当作完整名单的群人数（用来发现「名单突然变少」）。 */
  lastRosterSize: number
  /** 可疑的变少名单人数，等下一轮核对（连续两轮一样才当作真的退群）。 */
  rosterCandidate: number
  /** 上一轮完整巡检实际执行的模式（只用来在报告里提示「模式已改为 X」）。 */
  lastMode: string
  lastPatrolAt: Date | null
  lastPatrolOk: boolean
  lastPatrolNote: string
}

/** 已经在运维群报过「管理员名片改不了」的人（同一张 AA 名片只报一次）。 */
export interface CardNote {
  groupId: string
  qq: string
  /** 当时 AA 给的名片。 */
  card: string
  /** refused：QQ 拒绝了（同一张名片不再重试）；role：机器人身份不够（0.2.0 留下的，0.2.1 起会重新试一次）。 */
  why: string
  reportedAt: Date
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
    aaqqbot_cardnote: CardNote
    aaqqbot_kv: KvRow
    aaqqbot_audit: AuditRow
  }
}

/** 当前的数据版本（kv 键 schema）。 */
const SCHEMA_VERSION = 2

export function extendModels(ctx: Context) {
  ctx.model.extend('aaqqbot_member', {
    groupId: { type: 'string', length: 32 },
    qq: { type: 'string', length: 32 },
    reason: { type: 'string', length: 64 },
    firstDeniedAt: 'timestamp',
    graceUntil: { type: 'timestamp', nullable: true },
    marked: 'boolean',
    lastRemindedAt: { type: 'timestamp', nullable: true },
    activeSince: { type: 'timestamp', nullable: true },
  }, { primary: ['groupId', 'qq'] })

  ctx.model.extend('aaqqbot_group', {
    groupId: { type: 'string', length: 32 },
    confirmedMode: { type: 'string', length: 16 }, // 0.2.0 起不用
    confirmedAt: { type: 'timestamp', nullable: true }, // 0.2.0 起不用
    confirmedBy: { type: 'string', length: 64 }, // 0.2.0 起不用
    holdSince: { type: 'timestamp', nullable: true },
    holdNote: 'text',
    holdSet: { type: 'text', initial: '' },
    lastConfirmAt: { type: 'timestamp', nullable: true },
    bypassUntil: { type: 'timestamp', nullable: true }, // 0.2.0 起不用
    bypassMaxNew: 'unsigned', // 0.2.0 起不用
    bypassMaxKicks: 'unsigned', // 0.2.0 起不用
    lastNewDenies: 'unsigned', // 0.2.0 起不用
    lastKicksDue: 'unsigned', // 0.2.0 起不用
    lastRosterSize: 'unsigned',
    rosterCandidate: { type: 'unsigned', initial: 0 },
    lastMode: { type: 'string', length: 16, initial: '' },
    lastPatrolAt: { type: 'timestamp', nullable: true },
    lastPatrolOk: 'boolean',
    lastPatrolNote: 'text',
  }, { primary: 'groupId' })

  ctx.model.extend('aaqqbot_cardnote', {
    groupId: { type: 'string', length: 32 },
    qq: { type: 'string', length: 32 },
    card: { type: 'string', length: 255 },
    why: { type: 'string', length: 16 },
    reportedAt: 'timestamp',
  }, { primary: ['groupId', 'qq'] })

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
    holdSet: '',
    lastConfirmAt: null,
    bypassUntil: null,
    bypassMaxNew: 0,
    bypassMaxKicks: 0,
    lastNewDenies: 0,
    lastKicksDue: 0,
    lastRosterSize: 0,
    rosterCandidate: 0,
    lastMode: '',
    lastPatrolAt: null,
    lastPatrolOk: false,
    lastPatrolNote: '',
  }
}

/** 旧数据行里没有的字段（undefined）补上默认值；null 保持不变。 */
function withDefaults<T extends object>(defaults: T, row: Partial<T>): T {
  const result = { ...defaults }
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) (result as any)[key] = value
  }
  return result
}

function normalizeTracked(row: TrackedMember): TrackedMember {
  return {
    ...row,
    graceUntil: row.graceUntil ?? null,
    lastRemindedAt: row.lastRemindedAt ?? null,
    activeSince: row.activeSince ?? null,
    marked: !!row.marked,
  }
}

export class Store {
  constructor(private ctx: Context, private now: () => number = Date.now) {}

  private get db() {
    return this.ctx.database
  }

  /**
   * 启动时迁移旧数据（0.1.x → 0.2.x）。
   * 迁移失败是安全的：旧记录会被当成「还没处置过」，最多让某个群多进一次冷静期、多一条报警。
   * 第一次开始迁移时记下时间（migrationCutoff），只转换那之前的记录：迁移中途失败、0.2.x 照常运行时写下的
   * 「只记录」行，下次重跑迁移也不会被当成「处置过」（DECISIONS 第 47 条）。
   */
  async migrate() {
    if (((await this.getKv<number>('schema')) ?? 1) >= SCHEMA_VERSION) return
    let cutoff = await this.getKv<number>('migrationCutoff')
    if (typeof cutoff !== 'number') {
      cutoff = this.now()
      await this.setKv('migrationCutoff', cutoff)
    }
    // 0.1.x 只在 remind / enforce 下写跟踪记录，所以旧记录都「处置过」
    for (const row of await this.db.get('aaqqbot_member', {})) {
      if (!row.activeSince && row.firstDeniedAt && new Date(row.firstDeniedAt).getTime() < cutoff) {
        await this.db.set('aaqqbot_member', { groupId: row.groupId, qq: row.qq }, { activeSince: row.firstDeniedAt })
      }
    }
    await this.setKv('schema', SCHEMA_VERSION)
  }

  /** 这个群的跟踪记录都改回「还没处置过」（0.1.x 里没确认过的模式升级，DECISIONS 第 50 条）。 */
  async resetActive(groupId: string) {
    await this.db.set('aaqqbot_member', { groupId }, { activeSince: null })
  }

  async tracked(groupId: string): Promise<Map<string, TrackedMember>> {
    const rows = await this.db.get('aaqqbot_member', { groupId })
    return new Map(rows.map((row) => [row.qq, normalizeTracked(row)]))
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

  /** 只更新已有的行；没有这一行时什么都不做。 */
  async setMarked(groupId: string, qq: string, marked: boolean) {
    await this.db.set('aaqqbot_member', { groupId, qq }, { marked })
  }

  async removeTracked(groupId: string, qqs: string[]) {
    if (qqs.length) await this.db.remove('aaqqbot_member', { groupId, qq: qqs })
  }

  /** 群从 AA 上移除：跟踪记录、名片记录、群状态都清掉，以后加回来从头开始。 */
  async forgetGroup(groupId: string) {
    await this.db.remove('aaqqbot_member', { groupId })
    await this.db.remove('aaqqbot_cardnote', { groupId })
    await this.db.remove('aaqqbot_group', { groupId })
  }

  async cardNotes(groupId: string): Promise<Map<string, CardNote>> {
    const rows = await this.db.get('aaqqbot_cardnote', { groupId })
    return new Map(rows.map((row) => [row.qq, row]))
  }

  async saveCardNote(groupId: string, qq: string, card: string, why: string) {
    await this.db.upsert('aaqqbot_cardnote', [{ groupId, qq, card, why, reportedAt: new Date(this.now()) }])
  }

  async removeCardNotes(groupId: string, qqs?: string[]) {
    if (!qqs) await this.db.remove('aaqqbot_cardnote', { groupId })
    else if (qqs.length) await this.db.remove('aaqqbot_cardnote', { groupId, qq: qqs })
  }

  async groupState(groupId: string): Promise<GroupState> {
    const [row] = await this.db.get('aaqqbot_group', { groupId })
    return row ? withDefaults(defaultGroupState(groupId), row) : defaultGroupState(groupId)
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

  async removeKv(key: string) {
    await this.db.remove('aaqqbot_kv', { key })
  }

  async audit(action: string, groupId: string, qq: string, detail: string, actor = 'bot') {
    await this.db.create('aaqqbot_audit', { at: new Date(this.now()), action, groupId, qq, detail, actor })
  }

  async countAudit(action: string, groupId: string, since: Date): Promise<number> {
    const rows = await this.db.get('aaqqbot_audit', { action, groupId, at: { $gte: since } }, ['id'])
    return rows.length
  }

  async auditSince(action: string, groupId: string, since: Date): Promise<AuditRow[]> {
    return this.db.get('aaqqbot_audit', { action, groupId, at: { $gte: since } })
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
