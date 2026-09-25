// 主引擎：巡检、入群申请、新人、事件、每日提醒、暂停与确认。
//
// 安全规则（交接文档 R5–R11、API.md 第 1.1 / 7.1 节）：
// - 拿不到 AA 的明确答案就什么都不做；review 永不处置。
// - 群主、管理员、机器人、白名单永不处置；移出前实时复核。
// - 未经管理员确认的模式升级按 report 执行；新增不合格人数超过阈值时整群熔断。
// - 暂停、停用插件、改配置都会立即中止正在进行的一轮。

import { Bot, Context, Fragment, h, Logger, Session, Universal } from 'koishi'
import { AaClient, ApiFailure, describeFailure, ManagedGroup, Verdict } from './aa'
import { Config, Mode, MODE_RANK } from './config'
import { Notifier } from './notifier'
import { Platform } from './platform'
import { canEditCard, isProtected, Member, Plan, planGroup, Role } from './policy'
import { extendModels, GroupState, isMode, Store, TrackedMember } from './store'
import { MODE_TEXT, reasonShort, rejectHint } from './texts'
import {
  AbortedError, chunk, errorText, fillTemplate, formatDeadline, formatShortTime, maskId,
  nextClockTime, normalizeId, normalizeIdList, parseClock, sleep, throwIfAborted,
} from './util'

export interface GuardOptions {
  now?: () => number
  /** 自动运行定时任务（测试里关掉，手动调用各方法）。 */
  timers?: boolean
  /** AA 请求失败时的重试等待。 */
  retryDelays?: number[]
  /** 两次改名片之间的间隔。 */
  cardDelayMs?: number
  /** 两次移出之间的间隔（实际在这个值到两倍之间随机）。 */
  kickDelayMs?: number
  /** 巡检时两个群之间的间隔。 */
  groupDelayMs?: number
}

export interface ModeInfo {
  desired: Mode
  effective: Mode
  /** 设了 remind / enforce 但还没确认。 */
  awaiting: boolean
  held: boolean
}

interface ApplyResult {
  cardsOk: number
  cardsFailed: number
  marked: number
  unmarked: number
  synced: number
  kicked: Array<{ qq: string; name: string }>
  kickFailed: number
  kickSkipped: number
}

const MAX_CHECK = 3000
const PATROL_BUDGET_MS = 30 * 60_000
const FLAG_TTL_MS = 30 * 60_000
const APPROVED_TTL_MS = 10 * 60_000
const AUDIT_KEEP_MS = 180 * 86400_000
const REMIND_CHUNK = 20
const REJECT_REASON_MAX = 200

export class Guard {
  readonly logger: Logger
  readonly aa: AaClient
  readonly store: Store
  readonly platform: Platform
  readonly notifier: Notifier

  groups: ManagedGroup[] = []
  groupsLoaded = false
  paused = false
  /** 运维群号出现在受管群列表里时为 true（这时不发通知，见 R18）。 */
  adminGroupConflict = false
  rosters = new Map<string, Map<string, Member>>()
  lastRound: { at: number; ok: boolean; text: string } | null = null
  patrolRunning = false
  nextPatrolAt: number | null = null

  /** start() 的执行结果（测试里用来等待启动完成）。 */
  started: Promise<void> | null = null

  private life = new AbortController()
  private round: AbortController | null = null
  private patrolQueue: Set<string> | 'all' | null = null
  private eventsBusy = false
  private remindBusy = false
  private aaDown = false
  private botProblem: string | null = null
  private handledFlags = new Map<string, number>()
  private approved = new Map<string, { card: string | null; at: number }>()
  private timers = new Map<string, () => void>()
  private lastPrune = 0

  constructor(private ctx: Context, public config: Config, private options: GuardOptions = {}) {
    this.logger = ctx.logger('aaqqbot')
    this.store = new Store(ctx, () => this.now())
    this.platform = new Platform(ctx, () => this.config.botId)
    this.aa = new AaClient(ctx, {
      baseUrl: config.aaBaseUrl,
      keyId: config.keyId.trim(),
      secret: config.secret,
      timeoutMs: config.timeoutSeconds * 1000,
    })
    this.notifier = new Notifier(this.platform, this.logger, () => this.adminGroup(), () => this.now())
  }

  // ------------------------------------------------------------ 基础

  now() {
    return this.options.now?.() ?? Date.now()
  }

  get signal() {
    return this.life.signal
  }

  adminGroup(): string | null {
    if (this.adminGroupConflict) return null
    return normalizeId(this.config.adminGroupId)
  }

  operators(): Set<string> {
    return new Set(normalizeIdList(this.config.operators))
  }

  protectedIds(): Set<string> {
    return new Set([...this.platform.allSelfIds(), ...normalizeIdList(this.config.whitelist)])
  }

  bindUrl(): string {
    const url = this.config.bindUrl?.trim()
    if (url) return url
    return `${this.config.aaBaseUrl.trim().replace(/\/+$/, '')}/services/`
  }

  group(groupId: string): ManagedGroup | undefined {
    return this.groups.find((g) => g.groupId === groupId)
  }

  groupLabel(groupId: string): string {
    const g = this.group(groupId)
    return g ? `${g.name}（${groupId}）` : groupId
  }

  desiredMode(groupId: string): Mode {
    for (const entry of this.config.groupModes ?? []) {
      if (normalizeId(entry.groupId) === groupId && isMode(entry.mode)) return entry.mode
    }
    return isMode(this.config.defaultMode) ? this.config.defaultMode : 'report'
  }

  modeInfo(groupId: string, state: GroupState): ModeInfo {
    const desired = this.desiredMode(groupId)
    const confirmed = isMode(state.confirmedMode) ? state.confirmedMode : 'report'
    const held = state.holdSince !== null
    if (MODE_RANK[desired] <= MODE_RANK.report || MODE_RANK[desired] <= MODE_RANK[confirmed]) {
      return { desired, effective: desired, awaiting: false, held }
    }
    // 没确认的升级先不生效，继续按已确认的模式执行（至少是 report）
    const effective: Mode = MODE_RANK[confirmed] >= MODE_RANK.report ? confirmed : 'report'
    return { desired, effective, awaiting: true, held }
  }

  private writeMode(info: ModeInfo) {
    return (info.effective === 'remind' || info.effective === 'enforce') && !info.held && !this.paused
  }

  // ------------------------------------------------------------ 启动与定时

  install() {
    extendModels(this.ctx)
    this.ctx.on('dispose', () => this.dispose())
    this.ctx.on('ready', () => {
      this.started = this.start().catch((error) => {
        if (!this.signal.aborted) this.logger.warn('启动出错：%s', error)
      })
    })
    this.ctx.on('guild-member-request', (session) => this.safely('入群申请', () => this.onRequestSession(session)))
    this.ctx.on('guild-member-added', (session) => this.safely('新成员入群', () => this.onMemberAdded(session)))
    this.ctx.on('guild-member-removed', (session) => this.safely('成员退群', () => this.onMemberRemoved(session)))
    this.ctx.on('bot-status-updated', (bot) => this.safely('机器人上线', () => this.onBotStatus(bot)))
  }

  dispose() {
    this.life.abort()
    this.round?.abort()
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
    this.notifier.dispose()
  }

  /** 包一层 try/catch：Koishi 里同步抛错会让整个进程退出（R20）。 */
  safely(what: string, task: () => unknown) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        if (error instanceof AbortedError || this.signal.aborted) return
        this.logger.warn('%s 出错：%s', what, error)
      })
  }

  async start() {
    this.paused = (await this.store.getKv<boolean>('paused')) ?? false
    const saved = await this.store.getKv<ManagedGroup[]>('groups')
    if (Array.isArray(saved) && saved.length) {
      this.groups = saved
      this.groupsLoaded = true
    }
    if (!parseClock(this.config.remindTime)) this.logger.warn('提醒时间 %s 格式不对，应为 19:30 这样的格式', this.config.remindTime)
    await this.checkHealth(true)
    await this.refreshGroups()
    if (this.paused) this.notifier.push('⏸ 插件处于暂停状态：不会审批、提醒、改名片或移出任何人。发送 aaqq.resume 恢复。')
    // 机器人已经在线（例如改配置后插件重启）时不会再收到上线事件，这里补处理一次积压的申请
    const bot = this.pickBot()
    if (bot && this.config.catchUpRequests) await this.catchUpRequests(bot)
    if (this.options.timers !== false) {
      this.schedule('patrol', 20_000, () => this.patrolTick())
      this.schedule('events', this.config.eventPollSeconds * 1000, () => this.eventsTick())
      this.schedule('groups', 3600_000, () => this.groupsTick())
      this.scheduleReminder()
    }
  }

  private schedule(name: string, delay: number, task: () => Promise<void>) {
    this.timers.get(name)?.()
    if (this.signal.aborted) return
    if (name === 'patrol') this.nextPatrolAt = this.now() + delay
    const cancel = this.ctx.setTimeout(() => {
      this.timers.delete(name)
      this.safely(name, task)
    }, delay)
    this.timers.set(name, cancel)
  }

  private async patrolTick() {
    const queue = this.patrolQueue
    this.patrolQueue = null
    const only = queue === 'all' || queue === null ? undefined : [...queue]
    let result: Awaited<ReturnType<Guard['runPatrol']>> = 'done'
    try {
      result = await this.runPatrol(only)
    } finally {
      // 巡检期间又有人要求巡检：马上再跑；机器人不在线或拿不到群列表：1 分钟后再试；否则等一个巡检周期
      const delay = this.patrolQueue ? 2000
        : result === 'no-bot' || result === 'no-groups' ? 60_000
          : this.config.patrolIntervalHours * 3600_000
      this.schedule('patrol', delay, () => this.patrolTick())
    }
  }

  private async eventsTick() {
    try {
      await this.pollEvents()
    } finally {
      this.schedule('events', this.config.eventPollSeconds * 1000, () => this.eventsTick())
    }
  }

  private async groupsTick() {
    try {
      await this.refreshGroups()
    } finally {
      this.schedule('groups', 3600_000, () => this.groupsTick())
    }
  }

  private scheduleReminder() {
    const clock = parseClock(this.config.remindTime) ?? { hour: 19, minute: 30 }
    const delay = nextClockTime(this.now(), clock.hour, clock.minute) - this.now()
    this.schedule('remind', delay, async () => {
      try {
        await this.runReminders()
      } finally {
        this.scheduleReminder()
      }
    })
  }

  /** 尽快巡检（全部群或指定的群）。正在巡检时，结束后立刻再跑一轮。 */
  requestPatrol(groupIds?: string[]) {
    if (!groupIds) {
      this.patrolQueue = 'all'
    } else if (this.patrolQueue !== 'all') {
      this.patrolQueue = new Set([...(this.patrolQueue ?? []), ...groupIds])
    }
    if (this.options.timers !== false && !this.patrolRunning) {
      this.schedule('patrol', 2000, () => this.patrolTick())
    }
  }

  // ------------------------------------------------------------ AA 状态

  private noteAaFailure(result: ApiFailure, context: string) {
    if (result.kind === 'aborted') return
    this.logger.warn('AA 请求失败（%s）：%s', context, describeFailure(result))
    if (!this.aaDown) {
      this.aaDown = true
      this.notifier.push(`⚠ AA 连接出问题（${context}）：${describeFailure(result)}\n恢复之前不会处置任何人。恢复后会通知。`)
    }
  }

  private noteAaOk() {
    if (this.aaDown) {
      this.aaDown = false
      this.notifier.push('✅ AA 已恢复连接。')
    }
  }

  private pickBot(): Bot | null {
    const { bot, problem } = this.platform.pickBot()
    if (!bot) {
      if (this.botProblem !== problem) {
        this.botProblem = problem
        this.logger.warn('机器人不可用：%s', problem)
      }
      return null
    }
    if (this.botProblem) {
      this.botProblem = null
      this.logger.info('机器人 %s 可用', bot.selfId)
    }
    return bot
  }

  async checkHealth(notify: boolean): Promise<string> {
    const result = await this.aa.health({ signal: this.signal, retryDelays: [] })
    if (!result.ok) {
      if (notify) this.noteAaFailure(result, '健康检查')
      return `❌ 连不上 AA：${describeFailure(result)}`
    }
    this.noteAaOk()
    const lines = [`AA 插件版本 ${result.version}，配置${result.configOk ? '正常' : '有问题'}`]
    if (result.problems.length) lines.push(`AA 自检发现的问题：${result.problems.join('、')}（含义见 aa-qqbot 的 API.md 5.1 节）`)
    const skew = this.aa.clockSkewMs
    if (skew !== null && Math.abs(skew) > 60_000) {
      lines.push(`⚠ 机器人电脑和 AA 服务器的时间相差 ${Math.round(skew / 1000)} 秒，超过 300 秒会导致请求被拒绝；请打开机器人电脑的自动对时`)
    }
    if (notify && (!result.configOk || result.problems.length || (skew !== null && Math.abs(skew) > 60_000))) {
      this.notifier.push(`⚠ AA 健康检查：\n${lines.join('\n')}`)
    }
    return lines.join('\n')
  }

  async refreshGroups(): Promise<boolean> {
    const result = await this.aa.groups({ signal: this.signal })
    if (!result.ok) {
      this.noteAaFailure(result, '获取受管群列表')
      return false
    }
    this.noteAaOk()
    const before = new Set(this.groups.map((g) => g.groupId))
    this.groups = result.groups
    this.groupsLoaded = true
    await this.store.setKv('groups', this.groups)
    const now = new Set(this.groups.map((g) => g.groupId))
    for (const groupId of this.rosters.keys()) {
      if (!now.has(groupId)) this.rosters.delete(groupId)
    }
    const added = [...now].filter((id) => !before.has(id))
    const removed = [...before].filter((id) => !now.has(id))
    for (const groupId of removed) await this.store.removeGroupTracking(groupId)

    const admin = normalizeId(this.config.adminGroupId)
    const conflict = !!admin && now.has(admin)
    if (conflict && !this.adminGroupConflict) {
      this.logger.error('运维群 %s 同时是受管群！运维群只能放管理人员，已停止发送运维通知。请在插件配置里换一个运维群。', admin)
    }
    this.adminGroupConflict = conflict
    if (before.size && (added.length || removed.length)) {
      const parts = []
      if (added.length) parts.push(`新增：${added.map((id) => this.groupLabel(id)).join('、')}`)
      if (removed.length) parts.push(`移除：${removed.join('、')}`)
      this.notifier.push(`ℹ AA 上的受管群有变化。${parts.join('；')}`)
    }
    return true
  }

  // ------------------------------------------------------------ 巡检

  /**
   * 巡检一轮。返回 'busy'（上一轮还没结束）、'paused'、'no-bot'、'no-groups' 或 'done'。
   * 同一时间只有一轮（R11）；暂停、停用、改配置会立即中止（R10）。
   */
  async runPatrol(only?: string[]): Promise<'busy' | 'paused' | 'no-bot' | 'no-groups' | 'done'> {
    if (this.patrolRunning) {
      if (only) this.requestPatrol(only)
      else this.requestPatrol()
      return 'busy'
    }
    if (this.paused) return 'paused'
    this.patrolRunning = true
    const round = new AbortController()
    this.round = round
    const onLifeAbort = () => round.abort()
    this.signal.addEventListener('abort', onLifeAbort)
    const budget = setTimeout(() => round.abort(), PATROL_BUDGET_MS)
    const started = this.now()
    try {
      const bot = this.pickBot()
      if (!bot) {
        this.notifyBotProblemOnce()
        return 'no-bot'
      }
      if (!this.groupsLoaded) await this.refreshGroups()
      if (!this.groupsLoaded) return 'no-groups'
      const targets = this.groups.filter((g) => !only || only.includes(g.groupId))
      const sections: string[] = []
      let ok = true
      for (const [index, g] of targets.entries()) {
        throwIfAborted(round.signal)
        if (index > 0) await sleep(this.options.groupDelayMs ?? 5000, round.signal)
        const section = await this.patrolGroup(bot, g, round.signal)
        if (section.text) sections.push(section.text)
        ok &&= section.ok
      }
      const seconds = Math.round((this.now() - started) / 1000)
      const header = `【AA 巡检】${formatShortTime(started)} ${only ? '（指定的群）' : ''}完成，用时 ${seconds} 秒`
      const text = sections.length ? `${header}\n${sections.join('\n\n')}` : `${header}\n没有需要巡检的群（都是 off 或 AA 上没有受管群）`
      this.lastRound = { at: started, ok, text }
      this.notifier.push(text)
      await this.pruneAudit()
      return 'done'
    } catch (error) {
      if (error instanceof AbortedError || round.signal.aborted) {
        const why = this.paused ? '已暂停' : this.signal.aborted ? '插件已停用或配置已修改' : '超过 30 分钟时限'
        this.logger.info('巡检中止：%s', why)
        if (!this.signal.aborted) this.notifier.push(`⏹ 巡检已中止（${why}）。`)
        this.lastRound = { at: started, ok: false, text: `巡检中止（${why}）` }
        return 'done'
      }
      throw error
    } finally {
      clearTimeout(budget)
      this.signal.removeEventListener('abort', onLifeAbort)
      this.patrolRunning = false
      if (this.round === round) this.round = null
    }
  }

  private notifyBotProblemOnce() {
    const key = `bot:${this.botProblem}`
    if (this.handledFlags.has(key)) return
    this.handledFlags.set(key, this.now())
    this.logger.warn('巡检跳过：%s', this.botProblem)
  }

  async patrolGroup(bot: Bot, g: ManagedGroup, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const label = this.groupLabel(g.groupId)
    let state = await this.store.groupState(g.groupId)
    const info = this.modeInfo(g.groupId, state)
    // 降级立即生效：确认过的模式跟着降下来，以后再升级要重新确认
    if (MODE_RANK[info.desired] < MODE_RANK[state.confirmedMode as Mode] && MODE_RANK[state.confirmedMode as Mode] > MODE_RANK.report) {
      const confirmedMode = MODE_RANK[info.desired] >= MODE_RANK.report ? info.desired : 'report'
      await this.store.setGroupState(g.groupId, { confirmedMode })
      state = { ...state, confirmedMode }
    }
    if (info.effective === 'off') return { ok: true, text: '' }

    const head = `▶ ${label}　${MODE_TEXT[info.effective]}${info.awaiting ? `\n⚠ 设为了 ${info.desired}，还没确认，暂时按 ${info.effective} 执行。看完下面的报告确认无误后，发送：aaqq.confirm ${g.groupId}` : ''}${info.held ? `\n⛔ 熔断中（${state.holdNote || '新增不合格人数过多'}），不做任何处置。核实后发送：aaqq.confirm ${g.groupId}` : ''}`

    let members: Member[]
    try {
      members = await this.platform.listMembers(bot, g.groupId)
    } catch (error) {
      await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: '取群成员失败' })
      return { ok: false, text: `${head}\n❌ 取群成员名单失败（机器人可能不在这个群里）：${errorText(error)}` }
    }
    throwIfAborted(signal)
    this.rosters.set(g.groupId, new Map(members.map((m) => [m.qq, m])))
    const botRole = members.find((m) => m.qq === bot.selfId)?.role ?? null
    if (!botRole) {
      await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: '机器人不在群里' })
      return { ok: false, text: `${head}\n❌ 机器人不在这个群里` }
    }

    const qqs = members.map((m) => m.qq)
    const verdicts = new Map<string, Verdict>()
    const fullRoster = qqs.length <= MAX_CHECK
    for (const part of chunk(qqs, MAX_CHECK)) {
      const result = await this.aa.check(g.groupId, part, fullRoster, { signal, retryDelays: this.options.retryDelays })
      if (!result.ok) {
        if (result.kind === 'aborted') throw new AbortedError()
        this.noteAaFailure(result, `巡检 ${label}`)
        if (result.error === 'unknown_group') await this.refreshGroups()
        await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: 'AA 无法判断' })
        return { ok: false, text: `${head}\n❌ AA 无法判断，本群不做任何处置：${describeFailure(result)}` }
      }
      for (const [qq, verdict] of result.verdicts) verdicts.set(qq, verdict)
    }
    this.noteAaOk()
    throwIfAborted(signal)

    const now = this.now()
    const tracked = await this.store.tracked(g.groupId)
    const kicksLastHour = await this.store.countAudit('kick', g.groupId, new Date(now - 3600_000))
    const plan = planGroup({
      groupId: g.groupId,
      mode: this.paused ? 'report' : info.effective,
      held: info.held,
      bypassBreaker: state.bypassOnce,
      partial: false,
      groupSize: members.length,
      members,
      verdicts,
      tracked,
      protectedIds: this.protectedIds(),
      botRole,
      now,
      settings: this.planSettings(Math.max(0, this.config.kickPerHour - kicksLastHour), true),
    })

    const patch: Partial<GroupState> = { lastPatrolAt: new Date(now), lastPatrolOk: true, bypassOnce: false }
    if (plan.tripped) {
      patch.holdSince = new Date(now)
      patch.holdNote = `新增不合格 ${plan.newDenies.length} 人，超过阈值 ${plan.threshold} 人`
      await this.store.audit('hold', g.groupId, '', patch.holdNote)
    }
    const applied = await this.applyPlan(bot, g.groupId, plan, signal)
    patch.lastPatrolNote = `成员 ${members.length}，不合格 ${plan.counts.deny}`
    await this.store.setGroupState(g.groupId, patch)

    const lines = [head, ...this.describePlan(plan, applied, members, info)]
    if (!fullRoster) lines.push(`⚠ 群人数超过 ${MAX_CHECK}，名单分批提交，AA 上「老成员免验证」对这个群不生效`)
    if (plan.tripped) {
      this.notifier.push(`⛔ 熔断：${label} 本轮新增不合格 ${plan.newDenies.length} 人，超过阈值 ${plan.threshold} 人。\n可能是 AA 配置被改错了。这个群已停止一切处置（不提醒、不改名片、不移出、不拒绝申请），直到管理员确认。\n请先核对 AA 上的设置和下面的名单，确认无误后发送：aaqq.confirm ${g.groupId}`)
    }
    return { ok: true, text: lines.join('\n') }
  }

  private planSettings(kickBudget: number, allowKicks: boolean) {
    return {
      graceMs: this.config.graceHours * 3600_000,
      breakerCount: this.config.breakerCount,
      breakerPercent: this.config.breakerPercent,
      kickBudget,
      syncCards: this.config.syncCards,
      markCards: this.config.markCards,
      markPrefix: this.config.markPrefix ?? '',
      allowKicks,
    }
  }

  private describePlan(plan: Plan, applied: ApplyResult, members: Member[], info: ModeInfo): string[] {
    const byQq = new Map(members.map((m) => [m.qq, m]))
    const who = (qq: string) => {
      const m = byQq.get(qq)
      const name = m ? (m.card || m.nickname) : ''
      return name ? `${name}(${qq})` : qq
    }
    const list = (items: Array<{ qq: string; reason: string }>, max = 10) => {
      const shown = items.slice(0, max).map((x) => `${who(x.qq)} ${reasonShort(x.reason)}`)
      if (items.length > max) shown.push(`等共 ${items.length} 人`)
      return shown.join('；')
    }
    const c = plan.counts
    const newCount = plan.newDenies.length
    const lines = [`成员 ${c.members}：合格 ${c.allow}｜不合格 ${c.deny}${newCount ? `（新发现 ${newCount}）` : ''}｜需人工 ${c.review}｜无法判断 ${c.unknown}`]
    const actions: string[] = []
    if (applied.kicked.length) actions.push(`移出 ${applied.kicked.length} 人：${applied.kicked.map((k) => `${k.name}(${k.qq})`).join('、')}`)
    if (plan.kicksDeferred) actions.push(`${plan.kicksDeferred} 人因每小时上限推迟到下一轮`)
    if (applied.kickFailed) actions.push(`移出失败 ${applied.kickFailed} 人`)
    if (applied.kickSkipped) actions.push(`复核后跳过 ${applied.kickSkipped} 人`)
    if (applied.synced) actions.push(`同步名片 ${applied.synced} 人`)
    if (applied.marked) actions.push(`加标记 ${applied.marked} 人`)
    if (applied.unmarked) actions.push(`去标记 ${applied.unmarked} 人`)
    if (applied.cardsFailed) actions.push(`改名片失败 ${applied.cardsFailed} 次`)
    if (plan.cardsPending && !plan.writes) actions.push(`${plan.cardsPending} 人的名片与 AA 不一致（${info.effective === 'report' ? 'report 模式不修改' : '本轮不修改'}）`)
    if (actions.length) lines.push(actions.join('；'))
    if (plan.newDenies.length) lines.push(`新发现不合格：${list(plan.newDenies)}`)
    const old = plan.denies.filter((d) => !d.isNew)
    if (old.length) lines.push(`仍不合格：${list(old)}`)
    if (plan.reviews.length) lines.push(`需人工处理（在 AA「待处理」里处理）：${list(plan.reviews)}`)
    const selfIds = this.platform.allSelfIds()
    const protectedDenies = plan.protectedDenies.filter((d) => !selfIds.has(d.qq)) // 机器人自己没绑定是正常的，不报告
    if (protectedDenies.length) lines.push(`不合格但受保护（群主/管理员/白名单，不处置）：${list(protectedDenies)}`)
    if (plan.unknowns.length) lines.push(`无法判断：${plan.unknowns.slice(0, 10).map(who).join('、')}`)
    return lines
  }

  /**
   * 执行规划。每一次改动前都重新检查：没有中止、没有暂停；移出前再实时查询一次成员身份。
   * 通知失败不影响执行结果（R18）。
   */
  async applyPlan(bot: Bot, groupId: string, plan: Plan, signal: AbortSignal): Promise<ApplyResult> {
    const result: ApplyResult = { cardsOk: 0, cardsFailed: 0, marked: 0, unmarked: 0, synced: 0, kicked: [], kickFailed: 0, kickSkipped: 0 }
    await this.store.removeTracked(groupId, plan.untrack)
    await this.store.saveTracked(plan.track)
    const roster = this.rosters.get(groupId)

    for (const change of plan.cards) {
      if (signal.aborted || this.paused) break
      try {
        await this.platform.setCard(bot, groupId, change.qq, change.to)
        result.cardsOk++
        if (change.why === 'mark') result.marked++
        else if (change.why === 'unmark') result.unmarked++
        else result.synced++
        const member = roster?.get(change.qq)
        if (member) member.card = change.to
      } catch (error) {
        result.cardsFailed++
        this.logger.warn('改名片失败 群 %s 成员 %s：%s', groupId, maskId(change.qq), errorText(error))
      }
      await this.pause(this.options.cardDelayMs ?? 1500, signal)
    }

    if (plan.kicks.length) {
      // 移出前确认机器人自己仍是管理员
      const self = await this.platform.getMember(bot, groupId, bot.selfId)
      const botCanKick = self && (self.role === 'owner' || self.role === 'admin')
      for (const kick of plan.kicks) {
        if (signal.aborted || this.paused || !botCanKick) break
        const state = await this.store.groupState(groupId)
        const info = this.modeInfo(groupId, state)
        if (info.effective !== 'enforce' || info.held) break
        // 实时复核：还在群里、是普通成员、不是机器人、不在保护名单（R7）
        const live = await this.platform.getMember(bot, groupId, kick.qq)
        if (!live || isProtected(live, this.protectedIds()) || !canEditCard(self!.role, live)) {
          result.kickSkipped++
          continue
        }
        try {
          await this.platform.kick(bot, groupId, kick.qq)
          result.kicked.push({ qq: kick.qq, name: kick.name })
          roster?.delete(kick.qq)
          await this.store.removeTracked(groupId, [kick.qq])
          await this.store.audit('kick', groupId, kick.qq, reasonShort(kick.reason))
        } catch (error) {
          result.kickFailed++
          this.logger.warn('移出失败 群 %s 成员 %s：%s', groupId, maskId(kick.qq), errorText(error))
        }
        const base = this.options.kickDelayMs ?? 3000
        await this.pause(base + Math.random() * base, signal)
      }
      if (result.kicked.length && this.config.kickAnnounce) {
        const list = result.kicked.map((k) => k.name).join('、')
        const text = fillTemplate(this.config.kickAnnounceTemplate, { list, url: this.bindUrl() })
        try {
          await this.platform.sendGroup(bot, groupId, h.text(text))
        } catch (error) {
          this.logger.warn('发送移出公告失败 群 %s：%s', groupId, errorText(error))
        }
      }
    }
    return result
  }

  private async pause(ms: number, signal: AbortSignal) {
    if (ms > 0) await sleep(ms, signal).catch(() => {})
  }

  // ------------------------------------------------------------ 入群申请

  private async onRequestSession(session: Session) {
    if (session.platform !== 'onebot') return
    const bot = this.pickBot()
    if (!bot || session.selfId !== bot.selfId) return // 多个机器人时只让选定的那个处理（D37）
    const raw: any = (session as any).onebot ?? {}
    const groupId = normalizeId(session.guildId)
    const qq = normalizeId(session.userId)
    const flag = session.messageId
    if (!groupId || !qq || !flag) return
    await this.handleJoinRequest(bot, {
      flag,
      groupId,
      qq,
      comment: typeof raw.comment === 'string' ? raw.comment : (session.content ?? ''),
      invitorId: normalizeId(raw.invitor_id),
    })
  }

  async handleJoinRequest(bot: Bot, req: { flag: string; groupId: string; qq: string; comment: string; invitorId: string | null }, source = '入群申请') {
    this.pruneMaps()
    const g = this.group(req.groupId)
    if (!g) return // 不在受管群列表里的群一律不管（R6）
    if (this.handledFlags.has(req.flag)) return
    this.handledFlags.set(req.flag, this.now())
    const state = await this.store.groupState(g.groupId)
    const info = this.modeInfo(g.groupId, state)
    if (info.effective === 'off') return
    const label = this.groupLabel(g.groupId)
    const who = `${req.qq}${req.invitorId ? `（由 ${req.invitorId} 邀请）` : ''}`

    if (this.paused) {
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}。插件暂停中，留给管理员处理。`)
      return
    }
    if (req.invitorId && this.config.inviteHandling === 'manual') {
      this.notifier.push(`📥 ${source}：${who} 被邀请加入 ${label}。按设置，邀请入群留给管理员处理。`)
      return
    }

    const result = await this.aa.claim(req.qq, req.comment, g.groupId, { signal: this.signal, retryDelays: [2000] })
    if (!result.ok) {
      if (result.kind === 'aborted') return
      this.noteAaFailure(result, `入群申请 ${label}`)
      if (result.error === 'unknown_group') await this.refreshGroups()
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}。AA 无法判断（${describeFailure(result)}），留给管理员处理。`)
      return
    }
    this.noteAaOk()
    const verdict = result.verdict
    const outcomeText = result.claimed ? '验证码验证成功' : outcomeLabel(result.outcome)

    if (verdict.decision === 'allow') {
      try {
        await this.platform.handleJoinRequest(bot, req.flag, true)
        this.approved.set(`${g.groupId}:${req.qq}`, { card: verdict.card, at: this.now() })
        await this.store.audit('approve', g.groupId, req.qq, outcomeText)
        this.notifier.push(`✅ ${source}：已同意 ${who} 加入 ${label}（${outcomeText}）。`)
      } catch (error) {
        this.notifier.push(`⚠ ${source}：${who} 申请加入 ${label}，AA 判定合格，但同意时出错（可能已被管理员处理）：${errorText(error)}`)
      }
      return
    }

    if (verdict.decision === 'deny') {
      const reasonText = reasonShort(verdict.reason)
      if (this.writeMode(info) && this.config.autoReject) {
        const reason = fillTemplate(this.config.rejectTemplate, { hint: rejectHint(result.outcome, verdict.reason), url: this.bindUrl() }).slice(0, REJECT_REASON_MAX)
        try {
          await this.platform.handleJoinRequest(bot, req.flag, false, reason)
          await this.store.audit('reject', g.groupId, req.qq, `${reasonText}；${outcomeText}`)
          this.notifier.push(`🚫 ${source}：已拒绝 ${who} 加入 ${label}（${reasonText}；${outcomeText}）。`)
        } catch (error) {
          this.notifier.push(`⚠ ${source}：${who} 申请加入 ${label}，AA 判定不合格，但拒绝时出错（可能已被管理员处理）：${errorText(error)}`)
        }
        return
      }
      const why = info.held ? '这个群熔断中' : info.effective === 'report' ? `群模式是 report${info.awaiting ? '（升级还没确认）' : ''}` : '自动拒绝已关闭'
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}，AA 判定不合格（${reasonText}；${outcomeText}）。${why}，留给管理员处理。`)
      return
    }

    const why = verdict.decision === 'review' ? `需要人工处理（${reasonShort(verdict.reason)}）` : 'AA 的结果无法识别'
    this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}，${why}，留给管理员处理。`)
  }

  /** 机器人重新上线：补处理掉线期间积压的入群申请（DECISIONS 第 13 条）。 */
  private async onBotStatus(changed: Bot) {
    if (changed.platform !== 'onebot' || changed.status !== Universal.Status.ONLINE) return
    const bot = this.pickBot()
    if (!bot || bot.selfId !== changed.selfId) return
    if (this.config.catchUpRequests) await this.catchUpRequests(bot)
    if (!this.lastRound) this.requestPatrol()
  }

  async catchUpRequests(bot: Bot) {
    if (!this.groupsLoaded || this.paused) return
    let pending
    try {
      pending = await this.platform.pendingJoinRequests(bot)
    } catch (error) {
      this.logger.warn('补拉入群申请失败（LLBot 可能不支持 get_group_system_msg）：%s', errorText(error))
      return
    }
    for (const req of pending) {
      if (this.signal.aborted) return
      await this.handleJoinRequest(bot, req, '补处理的入群申请')
      await sleep(1000, this.signal)
    }
  }

  // ------------------------------------------------------------ 新人入群、退群

  private async onMemberAdded(session: Session) {
    if (session.platform !== 'onebot') return
    const bot = this.pickBot()
    if (!bot || session.selfId !== bot.selfId) return
    const groupId = normalizeId(session.guildId)
    const qq = normalizeId(session.userId)
    if (!groupId || !qq || qq === bot.selfId) return
    await this.handleNewMember(bot, groupId, qq)
  }

  async handleNewMember(bot: Bot, groupId: string, qq: string) {
    const g = this.group(groupId)
    if (!g || this.paused) return
    const state = await this.store.groupState(groupId)
    const info = this.modeInfo(groupId, state)
    if (info.effective === 'off') return
    const label = this.groupLabel(groupId)
    const key = `${groupId}:${qq}`
    const approved = this.approved.get(key)
    this.approved.delete(key)

    let member = await this.platform.getMember(bot, groupId, qq)
    if (!member) {
      await sleep(3000, this.signal)
      member = await this.platform.getMember(bot, groupId, qq)
    }
    if (!member) return
    const roster = this.rosters.get(groupId)
    roster?.set(qq, member)
    const self = await this.platform.getMember(bot, groupId, bot.selfId)
    const botRole = self?.role ?? null

    if (approved) {
      // 刚由机器人同意的申请：AA 已经判过 allow，只需要设名片
      if (this.writeMode(info) && this.config.syncCards && approved.card && member.card !== approved.card && canEditCard(botRole, member)) {
        try {
          await this.platform.setCard(bot, groupId, qq, approved.card)
          member.card = approved.card
        } catch (error) {
          this.logger.warn('给新成员设名片失败：%s', errorText(error))
        }
      }
      return
    }

    const result = await this.aa.check(groupId, [qq], false, { signal: this.signal, retryDelays: this.options.retryDelays })
    if (!result.ok) {
      if (result.kind !== 'aborted') this.noteAaFailure(result, `新成员 ${label}`)
      return
    }
    this.noteAaOk()
    const plan = planGroup({
      groupId,
      mode: info.effective,
      held: info.held,
      bypassBreaker: false,
      partial: true,
      groupSize: roster?.size ?? 1,
      members: [member],
      verdicts: result.verdicts,
      tracked: await this.store.tracked(groupId),
      protectedIds: this.protectedIds(),
      botRole,
      now: this.now(),
      settings: this.planSettings(0, false),
    })
    await this.applyPlan(bot, groupId, plan, this.signal)
    const verdict = result.verdicts.get(qq)!
    const name = member.card || member.nickname
    if (verdict.decision === 'allow') {
      this.notifier.push(`👋 ${label} 新成员 ${name}(${qq})：合格。`)
      return
    }
    if (plan.writes && plan.newDenies.length) {
      await this.sendReminder(bot, groupId, info.effective, plan.track.filter((t) => t.qq === qq))
    }
    const action = plan.writes ? '已开始宽限并提醒' : `群模式 ${info.effective}，只报告`
    this.notifier.push(`👋 ${label} 新成员 ${name}(${qq})：${verdict.decision === 'deny' ? `不合格（${reasonShort(verdict.reason)}），${action}` : verdict.decision === 'review' ? `需人工处理（${reasonShort(verdict.reason)}）` : 'AA 无法判断'}。`)
  }

  private async onMemberRemoved(session: Session) {
    if (session.platform !== 'onebot') return
    const groupId = normalizeId(session.guildId)
    const qq = normalizeId(session.userId)
    if (!groupId || !qq || !this.group(groupId)) return
    this.rosters.get(groupId)?.delete(qq)
    await this.store.removeTracked(groupId, [qq])
  }

  // ------------------------------------------------------------ 事件轮询（API.md 5.5、第 8 节）

  async pollEvents(): Promise<void> {
    if (this.eventsBusy || this.paused || this.patrolRunning) return
    this.eventsBusy = true
    try {
      const cursor = await this.store.getKv<number>('cursor')
      if (typeof cursor !== 'number') {
        await this.initCursor()
        return
      }
      const qqs = new Set<string>()
      let groupsChanged = false
      let recheckAll = false
      let last = cursor
      for (let page = 0; page < 20; page++) {
        const result = await this.aa.events(last, 200, { signal: this.signal, retryDelays: [] })
        if (!result.ok) {
          this.noteAaFailure(result, '拉取变化')
          return
        }
        this.noteAaOk()
        for (const event of result.events) {
          if ((event.kind === 'recheck' || event.kind === 'card') && event.qq) qqs.add(event.qq)
          else if (event.kind === 'recheck_all') recheckAll = true
          else if (event.kind === 'groups') groupsChanged = true
        }
        last = result.lastId
        if (!result.hasMore) break
      }
      if (groupsChanged) await this.refreshGroups()
      if (recheckAll) {
        this.requestPatrol()
      } else if (qqs.size) {
        const ok = await this.recheck([...qqs])
        if (!ok) return // 先处理、后保存：没处理完就不前进，下次重来
      }
      if (last !== cursor) await this.store.setKv('cursor', last)
    } finally {
      this.eventsBusy = false
    }
  }

  /** 游标丢失（第一次运行）：把已有事件拉完只记游标，然后做一次完整巡检。 */
  private async initCursor() {
    let last = 0
    for (let page = 0; page < 1000; page++) {
      const result = await this.aa.events(last, 500, { signal: this.signal, retryDelays: [] })
      if (!result.ok) {
        this.noteAaFailure(result, '初始化事件游标')
        return
      }
      last = result.lastId
      if (!result.hasMore) break
    }
    await this.store.setKv('cursor', last)
    this.requestPatrol()
  }

  /** 按群合并复查一批 QQ（每个群只发一次 check）。返回是否全部处理完。 */
  async recheck(qqs: string[]): Promise<boolean> {
    const bot = this.pickBot()
    if (!bot) return false
    const lines: string[] = []
    for (const g of this.groups) {
      const state = await this.store.groupState(g.groupId)
      const info = this.modeInfo(g.groupId, state)
      if (info.effective === 'off') continue
      let roster = this.rosters.get(g.groupId)
      if (!roster) {
        try {
          const members = await this.platform.listMembers(bot, g.groupId)
          roster = new Map(members.map((m) => [m.qq, m]))
          this.rosters.set(g.groupId, roster)
        } catch {
          continue // 机器人不在这个群里；巡检会报告
        }
      }
      const inGroup = qqs.filter((qq) => roster!.has(qq))
      if (!inGroup.length) continue
      const members = inGroup.map((qq) => roster!.get(qq)!)
      const verdicts = new Map<string, Verdict>()
      for (const part of chunk(inGroup, MAX_CHECK)) {
        const result = await this.aa.check(g.groupId, part, false, { signal: this.signal, retryDelays: this.options.retryDelays })
        if (!result.ok) {
          if (result.kind === 'aborted') return false
          this.noteAaFailure(result, `复查 ${this.groupLabel(g.groupId)}`)
          if (result.error === 'unknown_group') {
            await this.refreshGroups()
            break
          }
          return false
        }
        for (const [qq, verdict] of result.verdicts) verdicts.set(qq, verdict)
      }
      if (verdicts.size !== inGroup.length) continue
      const botRole = roster.get(bot.selfId)?.role ?? null
      const plan = planGroup({
        groupId: g.groupId,
        mode: info.effective,
        held: info.held,
        bypassBreaker: false,
        partial: true,
        groupSize: roster.size,
        members,
        verdicts,
        tracked: await this.store.tracked(g.groupId),
        protectedIds: this.protectedIds(),
        botRole,
        now: this.now(),
        settings: this.planSettings(0, false),
      })
      if (plan.tripped) {
        const note = `AA 变化后新增不合格 ${plan.newDenies.length} 人，超过阈值 ${plan.threshold} 人`
        await this.store.setGroupState(g.groupId, { holdSince: new Date(this.now()), holdNote: note })
        await this.store.audit('hold', g.groupId, '', note)
        this.notifier.push(`⛔ 熔断：${this.groupLabel(g.groupId)} ${note}。这个群已停止一切处置，核实后发送：aaqq.confirm ${g.groupId}`)
      }
      const applied = await this.applyPlan(bot, g.groupId, plan, this.signal)
      const changed = plan.newDenies.length || plan.untrack.length || applied.cardsOk
      if (changed) lines.push([`▶ ${this.groupLabel(g.groupId)}　${MODE_TEXT[info.effective]}`, ...this.describePlan(plan, applied, members, info)].join('\n'))
    }
    if (lines.length) this.notifier.push(`【AA 变化复查】\n${lines.join('\n\n')}`)
    return true
  }

  // ------------------------------------------------------------ 每日提醒

  async runReminders(): Promise<void> {
    if (this.remindBusy || this.paused) return
    this.remindBusy = true
    try {
      const bot = this.pickBot()
      if (!bot) return
      for (const g of this.groups) {
        if (this.signal.aborted || this.paused) return
        const state = await this.store.groupState(g.groupId)
        const info = this.modeInfo(g.groupId, state)
        if (!this.writeMode(info)) continue
        const tracked = await this.store.tracked(g.groupId)
        if (!tracked.size) continue
        let members: Member[]
        try {
          members = await this.platform.listMembers(bot, g.groupId)
        } catch {
          continue
        }
        const roster = new Map(members.map((m) => [m.qq, m]))
        this.rosters.set(g.groupId, roster)
        const targets = [...tracked.keys()].filter((qq) => roster.has(qq))
        if (!targets.length) continue
        // 提醒前再问一次 AA，刚绑定好的人不会被 @
        const result = await this.aa.check(g.groupId, targets, false, { signal: this.signal, retryDelays: this.options.retryDelays })
        if (!result.ok) {
          if (result.kind !== 'aborted') this.noteAaFailure(result, `提醒 ${this.groupLabel(g.groupId)}`)
          continue
        }
        const plan = planGroup({
          groupId: g.groupId,
          mode: info.effective,
          held: false,
          bypassBreaker: false,
          partial: true,
          groupSize: members.length,
          members: targets.map((qq) => roster.get(qq)!),
          verdicts: result.verdicts,
          tracked,
          protectedIds: this.protectedIds(),
          botRole: roster.get(bot.selfId)?.role ?? null,
          now: this.now(),
          settings: this.planSettings(0, false),
        })
        await this.applyPlan(bot, g.groupId, plan, this.signal)
        if (plan.writes) await this.sendReminder(bot, g.groupId, info.effective, plan.track)
      }
    } finally {
      this.remindBusy = false
    }
  }

  /** 在群里 @ 提醒（每条最多 20 人）。 */
  async sendReminder(bot: Bot, groupId: string, mode: Mode, rows: TrackedMember[]) {
    if (!rows.length) return
    const template = mode === 'enforce' ? this.config.warnTemplate : this.config.remindTemplate
    const url = this.bindUrl()
    for (const part of chunk(rows, REMIND_CHUNK)) {
      const list: Fragment[] = []
      for (const row of part) {
        const deadline = mode === 'enforce' && row.graceUntil ? `，截止 ${formatDeadline(row.graceUntil.getTime())}` : ''
        list.push(h.at(row.qq), h.text(`（${reasonShort(row.reason)}${deadline}）\n`))
      }
      const [before, ...rest] = template.split('{list}')
      const after = rest.join('{list}')
      const content: Fragment[] = [h.text(fillTemplate(before, { url })), ...list]
      if (after) content.push(h.text(fillTemplate(after, { url })))
      try {
        await this.platform.sendGroup(bot, groupId, content as any)
        const at = new Date(this.now())
        await this.store.saveTracked(part.map((row) => ({ ...row, lastRemindedAt: at })))
      } catch (error) {
        this.logger.warn('发送提醒失败 群 %s：%s', groupId, errorText(error))
      }
    }
  }

  // ------------------------------------------------------------ 管理操作

  async setPaused(paused: boolean, actor: string) {
    this.paused = paused
    await this.store.setKv('paused', paused)
    await this.store.audit(paused ? 'pause' : 'resume', '', '', '', actor)
    if (paused) {
      this.round?.abort()
    } else {
      this.requestPatrol()
    }
  }

  /** 管理员确认：模式升级生效和/或解除熔断，下一轮不触发熔断，并马上重新巡检这个群。 */
  async confirm(groupId: string, actor: string): Promise<string> {
    const g = this.group(groupId)
    if (!g) return `${groupId} 不是 AA 上的受管群。`
    const state = await this.store.groupState(groupId)
    const info = this.modeInfo(groupId, state)
    const lastAt = state.lastPatrolAt?.getTime() ?? 0
    if (!state.lastPatrolOk || this.now() - lastAt > 24 * 3600_000) {
      return `这个群最近 24 小时没有成功的巡检报告。请先发送 aaqq.patrol ${groupId}，看完运维群里的报告再确认。`
    }
    const patch: Partial<GroupState> = { bypassOnce: true }
    const changes: string[] = []
    if (info.awaiting) {
      patch.confirmedMode = info.desired
      patch.confirmedAt = new Date(this.now())
      patch.confirmedBy = actor
      changes.push(`模式升级为 ${MODE_TEXT[info.desired]}`)
    }
    if (state.holdSince) {
      patch.holdSince = null
      patch.holdNote = ''
      changes.push('解除熔断')
    }
    if (!changes.length) return `${this.groupLabel(groupId)} 现在不需要确认（当前模式 ${MODE_TEXT[info.effective]}）。`
    await this.store.setGroupState(groupId, patch)
    await this.store.audit('confirm', groupId, '', changes.join('，'), actor)
    this.requestPatrol([groupId])
    return `已确认 ${this.groupLabel(groupId)}：${changes.join('，')}。马上重新巡检这个群，本轮不会触发熔断。`
  }

  async statusText(): Promise<string> {
    const lines: string[] = []
    lines.push(`状态：${this.paused ? '⏸ 暂停中' : '▶ 运行中'}`)
    const { bot, problem } = this.platform.pickBot()
    lines.push(`机器人：${bot ? `${bot.selfId} 在线` : `❌ ${problem}`}`)
    lines.push(`AA：${this.aaDown ? '❌ 最近一次请求失败' : '正常'}${this.aa.clockSkewMs !== null ? `（时间差 ${Math.round(this.aa.clockSkewMs / 1000)} 秒）` : ''}`)
    if (this.adminGroupConflict) lines.push('❌ 运维群同时是受管群，已停止发送运维通知，请修改配置')
    if (this.lastRound) lines.push(`上次巡检：${formatShortTime(this.lastRound.at)}${this.lastRound.ok ? '' : '（有问题）'}`)
    if (this.patrolRunning) lines.push('正在巡检中')
    else if (this.nextPatrolAt) lines.push(`下次巡检：${formatShortTime(this.nextPatrolAt)}`)
    if (!this.groupsLoaded) {
      lines.push('受管群：还没从 AA 拿到列表')
    } else if (!this.groups.length) {
      lines.push('受管群：AA 上还没有配置受管群')
    } else {
      lines.push('受管群：')
      for (const g of this.groups) {
        const state = await this.store.groupState(g.groupId)
        const info = this.modeInfo(g.groupId, state)
        const tracked = await this.store.tracked(g.groupId)
        const extra: string[] = []
        if (info.awaiting) extra.push(`设为 ${info.desired}，等待确认`)
        if (info.held) extra.push('熔断中')
        if (tracked.size) extra.push(`宽限中 ${tracked.size} 人`)
        lines.push(`· ${this.groupLabel(g.groupId)}：${MODE_TEXT[info.effective]}${extra.length ? `（${extra.join('，')}）` : ''}`)
      }
    }
    return lines.join('\n')
  }

  /** 查询一个 QQ 在各受管群的判定（只给运维用，输出不含角色名）。 */
  async checkQq(qq: string): Promise<string> {
    if (!this.groups.length) return 'AA 上还没有受管群。'
    const lines = [`QQ ${qq}：`]
    for (const g of this.groups) {
      const result = await this.aa.check(g.groupId, [qq], false, { signal: this.signal, retryDelays: [] })
      const inGroup = this.rosters.get(g.groupId)?.has(qq)
      const where = inGroup === undefined ? '' : inGroup ? '（在群里）' : '（不在群里）'
      if (!result.ok) {
        lines.push(`· ${this.groupLabel(g.groupId)}${where}：无法判断（${describeFailure(result)}）`)
        continue
      }
      const verdict = result.verdicts.get(qq)!
      const text = verdict.decision === 'allow' ? '合格' : verdict.decision === 'deny' ? `不合格：${reasonShort(verdict.reason)}` : verdict.decision === 'review' ? `需人工：${reasonShort(verdict.reason)}` : '无法判断'
      lines.push(`· ${this.groupLabel(g.groupId)}${where}：${text}`)
    }
    return lines.join('\n')
  }

  // ------------------------------------------------------------ 杂项

  private pruneMaps() {
    const now = this.now()
    for (const [flag, at] of this.handledFlags) if (now - at > FLAG_TTL_MS) this.handledFlags.delete(flag)
    for (const [key, value] of this.approved) if (now - value.at > APPROVED_TTL_MS) this.approved.delete(key)
  }

  private async pruneAudit() {
    const now = this.now()
    if (now - this.lastPrune < 86400_000) return
    this.lastPrune = now
    await this.store.pruneAudit(new Date(now - AUDIT_KEEP_MS))
  }
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'claimed': return '验证码验证成功'
    case 'no_code': return '申请里没有验证码'
    case 'code_invalid': return '验证码不对'
    case 'code_expired': return '验证码已过期'
    case 'code_used': return '验证码已用过'
    case 'qq_mismatch': return '验证码不是给这个 QQ 的'
    default: return outcome || '—'
  }
}

export type { Role }
