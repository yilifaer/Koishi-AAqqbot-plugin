// 主引擎：巡检、入群申请、新人、事件、每日提醒、暂停与冷静期。
//
// 安全规则（交接文档 R5–R11、API.md 第 1.1 / 7.1 节）：
// - 拿不到 AA 的明确答案就什么都不做；review 永不处置。
// - 群主、管理员永不移出（不合格时默认也加标记、单独提醒，DECISIONS 第 51 条）；
//   机器人、QQ 官方机器人、白名单永不提醒、永不加标记、永不移出。加标记、移出前都实时复核。
// - 改模式下一轮巡检直接生效；一轮里要开始处置的人太多时，这个群先进入冷静期（只报告、报警），
//   到时间后还是那批人就自动继续，变化大就重新冷静（DECISIONS 第 38、39 条）。
// - 暂停、停用插件、改配置都会立即中止正在进行的一轮。

import { Bot, Context, Fragment, h, Logger, Session, Universal } from 'koishi'
import { AaClient, ApiFailure, describeFailure, ManagedGroup, Verdict } from './aa'
import { Config, Mode } from './config'
import { Notifier } from './notifier'
import { Platform } from './platform'
import {
  botCanWrite, canEditCard, Cooling, emptyPlan, isExempt, isProtected, Member, Plan, planGroup, planRelease, PlanSettings, Role,
} from './policy'
import { CardNote, extendModels, GroupState, isMode, Store, TrackedMember } from './store'
import { MODE_TEXT, reasonShort, rejectHint } from './texts'
import {
  AbortedError, charLength, chunk, displayName, errorText, fillTemplate, formatDeadline, formatShortTime, isOneBotRefusal,
  isOneBotTimeout, maskId, MAX_MESSAGE_CHARS, nextClockTime, normalizeId, normalizeIdList, ONEBOT_TIMEOUT_HINT, parseClock,
  sleep, splitMessage, throwIfAborted,
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
  /** 一轮巡检跑满多久就停下，剩下的群接着巡检（测试用）。 */
  patrolSoftBudgetMs?: number
}

export interface ModeInfo {
  /** 这个群现在的模式（就是配置里的模式，改了直接生效）。 */
  effective: Mode
  /** 这个群在冷静期。 */
  cooling: boolean
}

interface ApplyResult {
  cardsOk: number
  /** 加标记前实时复核，发现已经不是普通成员或不在群里，跳过的人数（DECISIONS 第 49 条）。 */
  markSkipped: number
  cardsFailed: number
  cardsDeferred: number
  marked: number
  unmarked: number
  synced: number
  /** 改成功的群主 / 管理员名片（K1）。 */
  adminSynced: string[]
  /** 被 QQ 拒绝的群主 / 管理员名片（K1）。 */
  adminRefused: Array<{ qq: string; to: string }>
  kicked: Array<{ qq: string; name: string }>
  kickFailed: number
  kickSkipped: number
}

/** 「管理员名片改不了」的报告小节，以及要写 / 删的名片记录（K1）。 */
interface AdminCardReport {
  lines: string[]
  save: Array<{ qq: string; card: string; why: string; listed: boolean }>
  drop: string[]
}

interface GroupSection {
  ok: boolean
  text: string
  /** 报告放进要发的消息以后再执行（写名片记录）。 */
  after?: () => Promise<void>
}

const MAX_CHECK = 3000
/** 一轮巡检跑满这么久，就在两个群之间停下，剩下的群马上接着巡检（不让排在后面的群一直轮不到）。 */
const PATROL_SOFT_BUDGET_MS = 20 * 60_000
/** 一轮巡检的硬上限：超过就中止（防止卡死）。 */
const PATROL_BUDGET_MS = 40 * 60_000
/** 名单比上一轮少了这么多，就怀疑名单不完整。 */
const ROSTER_DROP_MIN = 5
const ROSTER_DROP_RATIO = 0.1
/** 可疑的名单下一轮人数差不多（±2）时，当作真的退群。 */
const ROSTER_REPEAT_TOLERANCE = 2
const FLAG_TTL_MS = 30 * 60_000
const APPROVED_TTL_MS = 10 * 60_000
const AUDIT_KEEP_MS = 180 * 86400_000
const REMIND_CHUNK = 20
/** 估算群消息长度时，每个 @ 按这么多字算。 */
const AT_CHARS = 20
const REJECT_REASON_MAX = 200
/** 移出前这么久之内必须成功 @ 提醒过这个人。 */
const REMIND_FRESH_MS = 36 * 3600_000
/** 每个群每轮最多改几张名片（刚上线时名片很多，分几轮改完，不占满巡检时间）。 */
const MAX_CARDS_PER_ROUND = 100
/** 报告里每个分类最多列几个人。 */
const REPORT_LIST_MAX = 15
/** adapter-onebot 的 responseTimeout 小于这个值时提醒（毫秒）。 */
const MIN_RESPONSE_TIMEOUT_MS = 10_000
const TIMEOUT_SUFFIX = '（LLBot 响应超时，可能其实已经成功）'
/** 移出的操作记录里标明「截止时间在上次冷静期结束之后」，熔断按时间窗口累计时用（DECISIONS 第 46 条）。 */
const UNAPPROVED_KICK = '未经冷静期批准'
/** 移出的操作记录里标明「离开联盟」（DECISIONS 第 52 条）。 */
const FAST_KICK = '离开联盟'
const MODE_RANK: Record<Mode, number> = { off: 0, report: 1, remind: 2, enforce: 3 }

/** 每个机器人对象提醒过的 responseTimeout 值：同一个进程里同一个值只提醒一次。 */
const warnedTimeouts = new WeakMap<object, number>()

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
  /** 下一次「离开联盟」到期检查的时间（DECISIONS 第 52 条）。 */
  nextFastKickAt: number | null = null

  /** start() 的执行结果（测试里用来等待启动完成）。 */
  started: Promise<void> | null = null
  /** 启动时的数据迁移；读跟踪记录前先等它（失败也会 resolve）。 */
  migrated: Promise<void> = Promise.resolve()

  private life = new AbortController()
  private round: AbortController | null = null
  private patrolQueue: Set<string> | 'all' | null = null
  private eventsBusy = false
  private remindBusy = false
  private catchUpBusy = false
  private fastBusy = false
  /** 因为暂停或 AA 故障没处理成的入群申请（群:QQ）：AA 恢复、解除暂停时只补处理这些（DECISIONS 第 56 条）。 */
  private retryJoin = new Set<string>()
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

  /**
   * 事件游标和受管群列表是「某一个 AA」的数据：换了 AA 网址（例如从测试 AA 换到正式 AA）后要重新开始，
   * 否则会拿测试 AA 的游标去读正式 AA，漏掉一批变化。
   */
  get cursorKey(): string {
    return `cursor:${this.aaIdentity()}`
  }

  get groupsKey(): string {
    return `groups:${this.aaIdentity()}`
  }

  private aaIdentity(): string {
    return this.aa.endpoint('events').origin + this.aa.endpoint('events').pathname.replace(/qqbot\/api\/v1\/events\/$/, '')
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
    return { effective: this.desiredMode(groupId), cooling: state.holdSince !== null }
  }

  private writeMode(info: ModeInfo) {
    return (info.effective === 'remind' || info.effective === 'enforce') && !info.cooling && !this.paused
  }

  /** 「离开联盟」类原因（AA 的原因码）。 */
  fastReasons(): Set<string> {
    return new Set((this.config.fastReasons ?? ['NO_ACCESS', 'USER_INACTIVE']).map((r) => String(r).trim()).filter(Boolean))
  }

  /** 白名单里解析不了的条目（写错了、带了名字等），这些条目不会生效。 */
  invalidWhitelist(): string[] {
    return (this.config.whitelist ?? []).map((x) => String(x ?? '').trim()).filter((x) => x && !normalizeId(x))
  }

  /** 统计「最近移出」的起点：冷静中固定在冷静开始的那一刻往前一个冷静期（DECISIONS 第 53 条）。 */
  private kickWindowStart(state: GroupState, now: number): Date {
    return new Date((state.holdSince ? state.holdSince.getTime() : now) - this.cooldownMs())
  }

  private cooldownMs(): number {
    return (this.config.breakerCooldownHours ?? 6) * 3600_000
  }

  /** 群状态里的冷静期；holdSet 解析不了时按 0.1.x 留下的熔断（名单未知）处理。 */
  private coolingOf(state: GroupState): Cooling | null {
    if (!state.holdSince) return null
    let set: Set<string> | null = null
    if (state.holdSet) {
      try {
        const list = JSON.parse(state.holdSet)
        if (Array.isArray(list)) set = new Set(list.map(String))
      } catch {}
    }
    return { since: state.holdSince.getTime(), set }
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
    // 数据迁移在后台进行，不挡住定时任务（DECISIONS 第 34 条）；读跟踪记录的地方会先等它。
    // 迁移失败是安全的：旧记录会被当成「还没处置过」，最多让某个群多进一次冷静期、多一条报警。
    this.migrated = this.store.migrate().catch((error) => {
      if (!this.signal.aborted) this.logger.warn('数据迁移失败（不影响安全，最多多一次冷静期报警）：%s', error)
    })
    // 先读暂停状态：读不出来时按「暂停」处理（宁可不动，也不误动）
    try {
      this.paused = (await this.store.getKv<boolean>('paused')) ?? false
    } catch (error) {
      this.paused = true
      this.logger.error('读取暂停状态失败，为安全起见先暂停：%s', error)
      this.notifier.push('⚠ 启动时读取不到数据库里的暂停状态，为安全起见已暂停。检查 Koishi 的数据库插件后，发送 aaqq.resume 恢复。')
    }
    // 定时任务先安排好：后面任何一步出错，巡检、拉取变化、提醒都照常运行
    if (this.options.timers !== false) {
      this.schedule('patrol', 20_000, () => this.patrolTick())
      this.schedule('events', this.config.eventPollSeconds * 1000, () => this.eventsTick())
      this.schedule('groups', 3600_000, () => this.groupsTick())
      this.scheduleReminder()
    }
    if (!parseClock(this.config.remindTime)) this.logger.warn('提醒时间 %s 格式不对，应为 19:30 这样的格式', this.config.remindTime)
    await this.startStep('读取受管群列表', async () => {
      const saved = await this.store.getKv<ManagedGroup[]>(this.groupsKey)
      if (Array.isArray(saved) && saved.length && !this.groupsLoaded) {
        this.groups = saved
        this.groupsLoaded = true
      }
    })
    await this.startStep('检查 adapter-onebot 设置', async () => this.checkOneBotConfig(this.pickBot()))
    await this.startStep('检查白名单', async () => {
      const bad = this.invalidWhitelist()
      if (bad.length) this.notifier.push(`⚠ 白名单里有 ${bad.length} 条写得不对，没有生效：${bad.join('、')}（每一条只能填一个 QQ 号）`)
    })
    await this.startStep('安排离开联盟的到期检查', () => this.scheduleFastKicks())
    await this.startStep('健康检查', () => this.checkHealth(true))
    await this.startStep('获取受管群列表', () => this.refreshGroups())
    if (this.paused) this.notifier.push('⏸ 插件处于暂停状态：不会审批、提醒、改名片或移出任何人。发送 aaqq.resume 恢复。')
    // 机器人已经在线（例如改配置后插件重启）时不会再收到上线事件，这里补处理一次积压的申请
    await this.startStep('补处理积压的入群申请', async () => {
      const bot = this.pickBot()
      if (bot && this.config.catchUpRequests) await this.catchUpRequests(bot)
    })
  }

  private async startStep(what: string, step: () => Promise<unknown>) {
    try {
      await step()
    } catch (error) {
      if (!this.signal.aborted) this.logger.warn('启动步骤「%s」出错（不影响定时任务）：%s', what, error)
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

  // ------------------------------------------------------------ AA、LLBot 状态

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
      // AA 掉线期间留下的入群申请，按规则补处理（DECISIONS 第 45 条）
      this.catchUpSoon()
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

  /** adapter-onebot 的 responseTimeout（毫秒）；http 协议没有这个设置，返回 null。 */
  private responseTimeoutOf(bot: Bot | null): number | null {
    const c = (bot as any)?.config
    if ((c?.protocol === 'ws' || c?.protocol === 'ws-reverse') && typeof c.responseTimeout === 'number') return c.responseTimeout
    return null
  }

  /** responseTimeout 太小（K-1：有人设成了 600 毫秒）时提醒一次。 */
  checkOneBotConfig(bot: Bot | null) {
    if (!bot) return
    const timeout = this.responseTimeoutOf(bot)
    if (timeout === null || timeout >= MIN_RESPONSE_TIMEOUT_MS) return
    if (warnedTimeouts.get(bot) === timeout) return
    warnedTimeouts.set(bot, timeout)
    this.logger.warn('adapter-onebot 的 responseTimeout 只有 %d 毫秒，建议改成 60000', timeout)
    this.notifier.push(`⚠ adapter-onebot 的「responseTimeout」只有 ${timeout} 毫秒（单位是毫秒），LLBot 稍慢一点就会被当成失败。请在 Koishi 控制台 → 插件配置 → adapter-onebot 改成 60000，保存。`)
  }

  async checkHealth(notify: boolean): Promise<string> {
    const timeout = this.responseTimeoutOf(this.platform.pickBot().bot)
    const onebotLine = timeout === null ? null
      : `adapter-onebot 的 responseTimeout：${timeout} 毫秒${timeout < MIN_RESPONSE_TIMEOUT_MS ? '（⚠ 太小，请改成 60000）' : ''}`
    const result = await this.aa.health({ signal: this.signal, retryDelays: [] })
    if (!result.ok) {
      if (notify) this.noteAaFailure(result, '健康检查')
      return [`❌ 连不上 AA：${describeFailure(result)}`, ...(onebotLine ? [onebotLine] : [])].join('\n')
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
    if (onebotLine) lines.push(onebotLine)
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
    await this.store.setKv(this.groupsKey, this.groups)
    const now = new Set(this.groups.map((g) => g.groupId))
    for (const groupId of this.rosters.keys()) {
      if (!now.has(groupId)) this.rosters.delete(groupId)
    }
    const added = [...now].filter((id) => !before.has(id))
    const removed = [...before].filter((id) => !now.has(id))
    for (const groupId of removed) await this.store.forgetGroup(groupId)

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
      await this.migrated
      const targets = this.groups.filter((g) => !only || only.includes(g.groupId))
      const sections: string[] = []
      const afters: Array<() => Promise<void>> = []
      let ok = true
      const realStart = Date.now()
      for (const [index, g] of targets.entries()) {
        throwIfAborted(round.signal)
        if (index > 0 && Date.now() - realStart >= (this.options.patrolSoftBudgetMs ?? PATROL_SOFT_BUDGET_MS)) {
          const rest = targets.slice(index)
          this.requestPatrol(rest.map((x) => x.groupId))
          sections.push(`⏭ 这一轮时间到了，还有 ${rest.length} 个群马上接着巡检：${rest.map((x) => this.groupLabel(x.groupId)).join('、')}`)
          break
        }
        if (index > 0) await sleep(this.options.groupDelayMs ?? 5000, round.signal)
        const section = await this.patrolGroup(bot, g, round.signal)
        if (section.text) sections.push(section.text)
        if (section.after) afters.push(section.after)
        ok &&= section.ok
      }
      const seconds = Math.round((this.now() - started) / 1000)
      const header = `【AA 巡检】${formatShortTime(started)} ${only ? '（指定的群）' : ''}完成，用时 ${seconds} 秒`
      const text = sections.length ? `${header}\n\n${sections.join('\n\n')}` : `${header}\n没有需要巡检的群（都是 off 或 AA 上没有受管群）`
      this.lastRound = { at: started, ok, text }
      this.notifier.push(text)
      for (const after of afters) {
        try {
          await after()
        } catch (error) {
          this.logger.warn('保存管理员名片记录出错：%s', error)
        }
      }
      await this.pruneAudit()
      await this.scheduleFastKicks()
      return 'done'
    } catch (error) {
      if (error instanceof AbortedError || round.signal.aborted) {
        const why = this.paused ? '已暂停' : this.signal.aborted ? '插件已停用或配置已修改' : '超过 40 分钟时限'
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

  async patrolGroup(bot: Bot, g: ManagedGroup, signal: AbortSignal): Promise<GroupSection> {
    const label = this.groupLabel(g.groupId)
    let state = await this.store.groupState(g.groupId)
    const mode = this.desiredMode(g.groupId)
    // 降到 report / off：先清掉冷静状态，否则这一轮的撤标记一张都做不了（stillWritable）
    if ((mode === 'report' || mode === 'off') && state.holdSince) state = await this.clearCooling(g.groupId, mode)
    if (mode === 'off') {
      await this.cleanupOffGroup(bot, g.groupId, signal)
      await this.store.setGroupState(g.groupId, { lastMode: 'off' })
      return { ok: true, text: '' }
    }

    const head = [`▶ ${label}　${MODE_TEXT[mode]}`]
    // 上一个模式：0.1.x 的数据只有 confirmedMode（从来没巡检过的新群不提示）
    const previousMode = state.lastMode || (state.lastPatrolAt ? state.confirmedMode : '')
    if (previousMode && previousMode !== mode) {
      head.push(`ℹ 模式已从 ${MODE_TEXT[previousMode] ?? `${previousMode} `}改为 ${MODE_TEXT[mode]}，本轮开始生效`)
    }
    const writesMode = mode === 'remind' || mode === 'enforce'
    const stateCoolingLine = () => (writesMode && state.holdSince ? [this.coolingLine(state.holdNote, state.holdSince.getTime())] : [])

    let members: Member[]
    try {
      members = await this.platform.listMembers(bot, g.groupId)
    } catch (error) {
      await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: '取群成员失败' })
      const why = isOneBotTimeout(error)
        ? `❌ 取群成员名单失败：${ONEBOT_TIMEOUT_HINT}`
        : `❌ 取群成员名单失败（机器人可能不在这个群里）：${errorText(error)}`
      return { ok: false, text: [...head, ...stateCoolingLine(), why].join('\n') }
    }
    throwIfAborted(signal)
    this.rosters.set(g.groupId, new Map(members.map((m) => [m.qq, m])))
    const botRole = members.find((m) => m.qq === bot.selfId)?.role ?? null
    if (!botRole) {
      await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: '机器人不在群里' })
      return { ok: false, text: [...head, ...stateCoolingLine(), '❌ 机器人不在这个群里'].join('\n') }
    }

    // 名单比上一轮明显变少：可能是 LLBot 刚启动、只返回了一部分人。
    // 这一轮不当作完整名单交给 AA（否则 AA 会删掉不在名单里的老成员），也不据此取消任何人的跟踪。
    // 「上一轮人数」不更新；下一轮人数还是差不多（±2）才当作真的退群（DECISIONS 第 42 条）。
    const previous = state.lastRosterSize
    const size = members.length
    const dropped = previous > 0 && previous - size > Math.max(ROSTER_DROP_MIN, Math.ceil(previous * ROSTER_DROP_RATIO))
    const repeated = dropped && state.rosterCandidate > 0 && Math.abs(size - state.rosterCandidate) <= ROSTER_REPEAT_TOLERANCE
    const suspicious = dropped && !repeated
    const qqs = members.map((m) => m.qq)
    const verdicts = new Map<string, Verdict>()
    const fullRoster = qqs.length <= MAX_CHECK && !suspicious
    for (const part of chunk(qqs, MAX_CHECK)) {
      const result = await this.aa.check(g.groupId, part, fullRoster, { signal, retryDelays: this.options.retryDelays })
      if (!result.ok) {
        if (result.kind === 'aborted') throw new AbortedError()
        this.noteAaFailure(result, `巡检 ${label}`)
        if (result.error === 'unknown_group') await this.refreshGroups()
        await this.store.setGroupState(g.groupId, { lastPatrolOk: false, lastPatrolNote: 'AA 无法判断' })
        return { ok: false, text: [...head, ...stateCoolingLine(), `❌ AA 无法判断，本群不做任何处置：${describeFailure(result)}`].join('\n') }
      }
      for (const [qq, verdict] of result.verdicts) verdicts.set(qq, verdict)
    }
    this.noteAaOk()
    throwIfAborted(signal)
    if (this.paused) throw new AbortedError()

    await this.migrated
    const now = this.now()
    // 0.1.x 里改了配置、还没 aaqq.confirm 的升级：旧记录重新算「第一次处置」，照样先冷静（DECISIONS 第 50 条）
    if (!state.lastMode && state.lastPatrolAt && isMode(state.confirmedMode) && writesMode
      && MODE_RANK[state.confirmedMode] < MODE_RANK[mode]) {
      await this.store.resetActive(g.groupId)
    }
    const tracked = await this.store.tracked(g.groupId)
    const notes = await this.store.cardNotes(g.groupId)
    const kicksLastHour = await this.store.countAudit('kick', g.groupId, new Date(now - 3600_000))
    const recentKicks = await this.store.auditSince('kick', g.groupId, this.kickWindowStart(state, now))
    const plan = planGroup({
      groupId: g.groupId,
      mode,
      cooling: this.coolingOf(state),
      releasedBefore: state.lastConfirmAt?.getTime() ?? 0,
      recentUnapprovedKicks: recentKicks.filter((row) => row.detail.includes(UNAPPROVED_KICK)).length,
      partial: suspicious,
      groupSize: members.length,
      members,
      verdicts,
      tracked,
      protectedIds: this.protectedIds(),
      selfIds: this.platform.allSelfIds(),
      refusedCards: refusedCards(notes),
      botRole,
      now,
      settings: this.planSettings(Math.max(0, this.config.kickPerHour - kicksLastHour), true),
    })

    // 冷静期的状态先写库，再执行（结束冷静时不先清掉，stillWritable 会挡住这一轮的改动）
    await this.applyBreaker(g.groupId, plan, state, now)
    const applied = await this.applyPlan(bot, g.groupId, plan, signal)
    await this.sendFastReminders(bot, g.groupId, mode, plan)
    await this.store.setGroupState(g.groupId, {
      lastPatrolAt: new Date(now),
      lastPatrolOk: true,
      lastPatrolNote: `成员 ${plan.counts.members}，不合格 ${plan.counts.deny}`,
      // 这一轮自己踢掉的人不算「名单变少」（DECISIONS 第 57 条）
      lastRosterSize: suspicious ? previous : Math.max(0, size - applied.kicked.length),
      rosterCandidate: suspicious ? size : 0,
      lastMode: mode,
    })

    const report = await this.adminCardReport(g.groupId, plan, applied, members, verdicts, notes, !suspicious)
    if (plan.breaker === 'cooling') head.push(this.coolingLine(state.holdNote, state.holdSince!.getTime()))
    else if (plan.breaker === 'trip' || plan.breaker === 'restart') head.push(this.coolingLine(plan.breakerReason, now))
    const warnings: string[] = []
    if (suspicious) {
      warnings.push(`⚠ 这次取到的名单比上一轮少了 ${previous - size} 人（${previous} → ${size}），可能不完整：本轮不作为完整名单交给 AA，也不取消任何人的跟踪。如果确实有很多人退群，下一轮人数一样时会自动恢复`)
    } else if (repeated) {
      warnings.push(`ℹ 连续两轮名单都是 ${size} 人（上次完整名单 ${previous} 人），按真的退群处理`)
    }
    if (!fullRoster && !suspicious) warnings.push(`⚠ 群人数超过 ${MAX_CHECK}，名单分批提交，AA 上「老成员免验证」对这个群不生效`)
    const text = this.renderSection(head, plan, applied, members, mode, report.lines, warnings)
    return { ok: true, text, after: () => this.commitAdminCards(g.groupId, report) }
  }

  /** 冷静中的报告头一行。 */
  private coolingLine(reason: string, since: number): string {
    return `⏸ 冷静中（${reason || '要开始处置的人太多'}）：${formatShortTime(since + this.cooldownMs())} 之后的第一次巡检自动决定是否继续`
  }

  /**
   * 按这一轮的熔断结果写冷静状态、操作记录和报警（K3）。
   * 必须在 applyPlan 之前调用：结束冷静（release）要先清掉 holdSince，否则 stillWritable 会挡住这一轮的改动。
   */
  private async applyBreaker(groupId: string, plan: Plan, state: GroupState, now: number) {
    const label = this.groupLabel(groupId)
    const hours = this.config.breakerCooldownHours ?? 6
    if (plan.breaker === 'trip') {
      await this.store.setGroupState(groupId, { holdSince: new Date(now), holdNote: plan.breakerReason, holdSet: JSON.stringify(plan.breakerSet) })
      await this.store.audit('cool-start', groupId, '', plan.breakerReason)
      this.notifier.push([
        `⏸ 冷静期开始：${label} ${plan.breakerReason}。`,
        '可能是 AA 设置被改错了。这个群先停止处置（不提醒、不加标记、不改名片、不移出、不拒绝申请），名单见巡检报告。',
        `${formatShortTime(now + this.cooldownMs())} 之后的第一次巡检：还是这批人就自动继续，变化很大就重新冷静。`,
        '如果是 AA 改错了，请在那之前改回来；要马上停止一切操作，发送 aaqq.pause。',
      ].join('\n'))
    } else if (plan.breaker === 'restart') {
      await this.store.setGroupState(groupId, { holdSince: new Date(now), holdNote: plan.breakerReason, holdSet: JSON.stringify(plan.breakerSet) })
      await this.store.audit('cool-restart', groupId, '', `${plan.breakerReason}；新增 ${plan.breakerAdded} 人`)
      const legacy = !state.holdSet
      this.notifier.push(legacy
        ? `⏸ 冷静期重新开始：${label} 升级前留下的熔断没有记下名单，现在记下这 ${plan.breakerAdded} 人（${plan.breakerReason}），再观察 ${hours} 小时。`
        : `⏸ 冷静期重新开始：${label} 和冷静开始时相比多了 ${plan.breakerAdded} 人（${plan.breakerReason}），再观察 ${hours} 小时。`)
    } else if (plan.breaker === 'release') {
      await this.store.setGroupState(groupId, { holdSince: null, holdNote: '', holdSet: '', lastConfirmAt: new Date(now) })
      const recovered = !plan.breakerReason && !plan.regraced
      await this.store.audit('cool-release', groupId, '', recovered ? '已恢复正常' : '情况和冷静开始时一致')
      const elapsed = Math.max(1, Math.round((now - (state.holdSince?.getTime() ?? now)) / 3600_000))
      this.notifier.push(recovered ? `▶ 冷静期结束：${label} 已恢复正常。`
        : plan.regraced
          ? `▶ 冷静期结束：${label} 情况和冷静开始时一致，开始正常处置（${plan.regraced} 人的截止时间已过期，重新提醒后再算宽限期）。`
          : `▶ 冷静期结束：${label} 情况和 ${elapsed} 小时前一致，开始正常处置。`)
    }
  }

  /** 群改成 report / off：取消冷静期（K2）。返回清掉以后的群状态。 */
  private async clearCooling(groupId: string, mode: Mode): Promise<GroupState> {
    await this.store.setGroupState(groupId, { holdSince: null, holdNote: '', holdSet: '' })
    await this.store.audit('cool-clear', groupId, '', `改成了 ${mode}`)
    this.notifier.push(`ℹ ${this.groupLabel(groupId)} 改成了 ${mode}，冷静期取消。`)
    return this.store.groupState(groupId)
  }

  /**
   * 群改成 off：撤掉以前加的标记、删掉在场的人的跟踪记录和名片记录，之后就不再管这个群。
   * 撤标记要等 QQ 确认改成功后才删记录（没撤掉的下一轮再撤）。
   */
  private async cleanupOffGroup(bot: Bot, groupId: string, signal: AbortSignal) {
    await this.store.removeCardNotes(groupId)
    await this.migrated
    const tracked = await this.store.tracked(groupId)
    if (!tracked.size) return
    let members: Member[]
    try {
      members = await this.platform.listMembers(bot, groupId)
    } catch {
      return
    }
    const botRole = members.find((m) => m.qq === bot.selfId)?.role ?? null
    const release = planRelease(members, tracked, this.protectedIds(), botRole, this.config.markPrefix ?? '')
    await this.applyPlan(bot, groupId, { ...emptyPlan(), cards: release.cards, untrack: release.untrack }, signal)
  }

  private planSettings(kickBudget: number, allowKicks: boolean): PlanSettings {
    return {
      remindFreshMs: REMIND_FRESH_MS,
      breakerCount: this.config.breakerCount,
      breakerPercent: this.config.breakerPercent,
      kickBudget,
      syncCards: this.config.syncCards,
      markCards: this.config.markCards,
      markPrefix: this.config.markPrefix ?? '',
      allowKicks,
      cooldownMs: this.cooldownMs(),
      markAdmins: this.config.markAdmins ?? true,
      fastReasons: this.fastReasons(),
      fastGraceMs: (this.config.fastGraceHours ?? 2) * 3600_000,
    }
  }

  /** 报告里的名字：名片（去掉标记和看不见的字符）→ 昵称；都没有时只显示 QQ。 */
  private who(member: Member | undefined, qq: string): string {
    const name = member ? displayName(member.card, member.nickname, this.config.markPrefix ?? '') : ''
    return name ? `${name}(${qq})` : qq
  }

  /** 一个群的报告：标题几行、统计行，然后各小节之间空一行。 */
  private renderSection(head: string[], plan: Plan, applied: ApplyResult, members: Member[], mode: Mode,
    adminLines: string[], warnings: string[]): string {
    const [stats, ...sections] = this.describePlan(plan, applied, members, mode, adminLines)
    if (warnings.length) sections.push(warnings.join('\n'))
    return [[...head, stats].join('\n'), ...sections].join('\n\n')
  }

  /**
   * 巡检报告（K5）：第一项是统计行，后面每一项是一个小节（多行）。
   * 顺序：本轮动作 → 已移出 → 新发现不合格 → 仍不合格 → 需人工处理 → 不合格但受保护 → 管理员名片 → 无法判断。
   */
  private describePlan(plan: Plan, applied: ApplyResult, members: Member[], mode: Mode, adminLines: string[] = []): string[] {
    const byQq = new Map(members.map((m) => [m.qq, m]))
    const who = (qq: string) => this.who(byQq.get(qq), qq)
    const c = plan.counts
    const newCount = plan.newDenies.length
    const result = [`成员 ${c.members}（不含机器人）：合格 ${c.allow}｜不合格 ${c.deny}${newCount ? `（新发现 ${newCount}）` : ''}｜需人工 ${c.review}｜无法判断 ${c.unknown}`]

    const actions: string[] = []
    if (plan.noRole) actions.push('机器人不是群主或管理员，本群不做任何改动')
    if (plan.unknownHeavy) actions.push('无法判断的人太多，本轮不做任何改动')
    if (applied.synced) actions.push(`同步名片 ${applied.synced} 人${applied.adminSynced.length ? `（其中群主/管理员 ${applied.adminSynced.length} 人）` : ''}`)
    if (applied.marked) actions.push(`加标记 ${applied.marked} 人`)
    if (applied.markSkipped) actions.push(`加标记前复核后跳过 ${applied.markSkipped} 人（已经不是普通成员或不在群里）`)
    if (applied.unmarked) actions.push(`去标记 ${applied.unmarked} 人`)
    if (applied.cardsFailed) actions.push(`改名片失败 ${applied.cardsFailed} 次`)
    if (applied.cardsDeferred) actions.push(`${applied.cardsDeferred} 张名片留到下一轮再改`)
    if (plan.cardsPending && !plan.writes) actions.push(`${plan.cardsPending} 人的名片与 AA 不一致（${mode === 'report' ? 'report 模式不修改' : '本轮不修改'}）`)
    if (plan.kicksDeferred) actions.push(`${plan.kicksDeferred} 人因每小时上限推迟到下一轮`)
    if (applied.kickFailed) actions.push(`移出失败 ${applied.kickFailed} 人`)
    if (applied.kickSkipped) actions.push(`复核后跳过 ${applied.kickSkipped} 人`)
    if (actions.length) result.push(['本轮动作', ...actions.map((a) => `· ${a}`)].join('\n'))

    if (applied.kicked.length) {
      result.push(listSection(`已移出 ${applied.kicked.length} 人`, applied.kicked.map((k) => ({ text: `${k.name}(${k.qq})` }))))
    }
    const staffTag = (staff?: string) => (staff === 'owner' ? '（群主，不移出）' : staff === 'admin' ? '（管理员，不移出）' : '')
    const byReason = (items: Array<{ qq: string; reason: string; staff?: string }>) =>
      items.map((x) => ({ text: `${who(x.qq)}${staffTag(x.staff)}`, group: reasonShort(x.reason) }))
    if (plan.newDenies.length) result.push(listSection(`新发现不合格 ${plan.newDenies.length} 人`, byReason(plan.newDenies)))
    const old = plan.denies.filter((d) => !d.isNew)
    if (old.length) result.push(listSection(`仍不合格 ${old.length} 人`, byReason(old)))
    if (plan.reviews.length) result.push(listSection(`需人工处理 ${plan.reviews.length} 人（在 AA「待处理」里处理）`, byReason(plan.reviews)))
    if (plan.protectedDenies.length) {
      result.push(listSection(`不合格但受保护 ${plan.protectedDenies.length} 人（群主/管理员/白名单，不处置）`, byReason(plan.protectedDenies)))
    }
    if (adminLines.length) result.push(adminLines.join('\n'))
    if (plan.unknowns.length) result.push(listSection(`无法判断 ${plan.unknowns.length} 人`, plan.unknowns.map((qq) => ({ text: who(qq) }))))
    return result
  }

  // ------------------------------------------------------------ 管理员名片（K1）

  /**
   * 算出「管理员名片与 AA 不一致」的报告小节和要写 / 删的名片记录（只读数据库，不写）。
   * 同一个人同一张 AA 名片只列一次；full = 完整名单时才清理过时的记录。
   */
  private async adminCardReport(groupId: string, plan: Plan, applied: ApplyResult, members: Member[],
    verdicts: Map<string, Verdict>, notes: Map<string, CardNote> | null, full: boolean): Promise<AdminCardReport> {
    notes ??= await this.store.cardNotes(groupId)
    const prefix = this.config.markPrefix ?? ''
    const byQq = new Map(members.map((m) => [m.qq, m]))
    const blocked = new Map<string, { to: string; why: string }>()
    // 计划里的「改不了」：同一张名片被 QQ 拒过（名片记录里有），否则是机器人身份不够
    for (const item of plan.adminCardsBlocked) {
      blocked.set(item.qq, { to: item.to, why: notes.get(item.qq)?.why === 'refused' ? 'refused' : 'role' })
    }
    for (const item of applied.adminRefused) blocked.set(item.qq, { to: item.to, why: 'refused' })

    const entries: string[] = []
    const save: AdminCardReport['save'] = []
    const drop = new Set<string>()
    for (const [qq, item] of blocked) {
      const note = notes.get(qq)
      if (note && note.card === item.to) {
        // 已经报过这张名片；QQ 拒绝时把原因改成 refused（以后不再重试）
        if (item.why === 'refused' && note.why !== 'refused') save.push({ qq, card: item.to, why: 'refused', listed: false })
        continue
      }
      entries.push(`· ${this.who(byQq.get(qq), qq)} → ${item.to}`)
      save.push({ qq, card: item.to, why: item.why, listed: true })
    }
    for (const qq of applied.adminSynced) {
      if (notes.has(qq)) drop.add(qq)
    }
    if (full) {
      for (const [qq, note] of notes) {
        if (blocked.has(qq) || drop.has(qq)) continue
        const member = byQq.get(qq)
        const verdict = verdicts.get(qq)
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) drop.add(qq)
        else if (verdict?.decision === 'review') drop.add(qq)
        // 不合格的群主 / 管理员：加标记被拒的记录留着（同一张标记名片不再重试），其余删
        else if (verdict?.decision === 'deny' && !(prefix && note.card.startsWith(prefix))) drop.add(qq)
        else if (verdict?.decision === 'allow' && (!verdict.card || verdict.card !== note.card)) drop.add(qq)
        // 其余（包括管理员自己把名片改好了）：记录保留，之后再改乱也不再报（Q5）
      }
    }
    const lines = entries.length
      ? [`群主/管理员的名片机器人改不了（请自己改成箭头后面的样子）${entries.length} 人`, ...limitList(entries)]
      : []
    return { lines, save, drop: [...drop] }
  }

  /** 写 / 删名片记录。只在报告小节已经放进要发的消息以后调用。 */
  private async commitAdminCards(groupId: string, report: AdminCardReport) {
    for (const item of report.save) {
      await this.store.saveCardNote(groupId, item.qq, item.card, item.why)
      if (item.listed) await this.store.audit('admin-card', groupId, item.qq, `${item.why === 'refused' ? 'QQ 拒绝' : '机器人身份不够'}：${item.card}`)
    }
    await this.store.removeCardNotes(groupId, report.drop)
  }

  // ------------------------------------------------------------ 执行

  /**
   * 执行规划。先移出、再改名片。每一次改动前都重新检查：没有中止、没有暂停、没有进入冷静期；
   * 移出前再问一次 AA、重读宽限记录、实时查询成员身份（R7）。通知失败不影响执行结果（R18）。
   * 撤标记要等 QQ 确认改成功后才落库：失败、被跳过、被推迟的下一轮再撤。
   */
  async applyPlan(bot: Bot, groupId: string, plan: Plan, signal: AbortSignal): Promise<ApplyResult> {
    const result: ApplyResult = {
      cardsOk: 0, markSkipped: 0, cardsFailed: 0, cardsDeferred: 0, marked: 0, unmarked: 0, synced: 0,
      adminSynced: [], adminRefused: [], kicked: [], kickFailed: 0, kickSkipped: 0,
    }
    await this.store.removeTracked(groupId, plan.untrack)
    await this.store.saveTracked(plan.track)
    const roster = this.rosters.get(groupId)

    if (plan.kicks.length) await this.applyKicks(bot, groupId, plan, signal, result)

    const cards = plan.cards.slice(0, MAX_CARDS_PER_ROUND)
    result.cardsDeferred = plan.cards.length - cards.length
    for (const [index, change] of cards.entries()) {
      if (!(await this.stillWritable(groupId, signal))) {
        result.cardsDeferred += cards.length - index
        break
      }
      if (change.why === 'mark') {
        // 加标记前实时复核（和移出一样）：刚被设为管理员、已经退群的人不加（DECISIONS 第 49 条）
        const live = await this.platform.getMember(bot, groupId, change.qq)
        if (!live || isExempt(live, this.protectedIds(), this.config.markAdmins ?? true)) {
          result.markSkipped++
          this.logger.info('加标记前复核：群 %s 成员 %s 已经不是普通成员或不在群里，不加标记', groupId, maskId(change.qq))
          continue
        }
      }
      try {
        await this.platform.setCard(bot, groupId, change.qq, change.to)
      } catch (error) {
        result.cardsFailed++
        if (change.admin && isOneBotRefusal(error)) result.adminRefused.push({ qq: change.qq, to: change.to })
        this.logger.warn('改名片失败 群 %s 成员 %s：%s%s', groupId, maskId(change.qq), errorText(error), isOneBotTimeout(error) ? TIMEOUT_SUFFIX : '')
        await this.pause(this.options.cardDelayMs ?? 1500, signal)
        continue
      }
      result.cardsOk++
      if (change.why === 'mark') result.marked++
      else if (change.why === 'unmark') result.unmarked++
      else result.synced++
      if (change.admin) result.adminSynced.push(change.qq)
      const member = roster?.get(change.qq)
      if (member) member.card = change.to
      if (change.untrackAfter) await this.store.removeTracked(groupId, [change.qq])
      else if (change.why === 'unmark') await this.store.setMarked(groupId, change.qq, false)
      else if (change.why === 'mark') await this.store.setMarked(groupId, change.qq, true)
      await this.pause(this.options.cardDelayMs ?? 1500, signal)
    }
    return result
  }

  /** 还能不能继续改动这个群：没有中止、没有暂停、不在冷静期。 */
  private async stillWritable(groupId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.paused) return false
    const state = await this.store.groupState(groupId)
    return state.holdSince === null
  }

  private async applyKicks(bot: Bot, groupId: string, plan: Plan, signal: AbortSignal, result: ApplyResult) {
    // 移出前确认机器人自己仍是管理员
    const self = await this.platform.getMember(bot, groupId, bot.selfId)
    if (!self || !botCanWrite(self.role)) return
    // 再问一次 AA：巡检开始后刚绑定好的人不能被移出
    const targets = plan.kicks.map((k) => k.qq)
    const fresh = await this.aa.check(groupId, targets, false, { signal, retryDelays: [] })
    if (!fresh.ok) {
      if (fresh.kind !== 'aborted') this.noteAaFailure(fresh, `移出前复核 ${this.groupLabel(groupId)}`)
      return
    }
    for (const kick of plan.kicks) {
      if (!(await this.stillWritable(groupId, signal))) break
      if (this.desiredMode(groupId) !== 'enforce') break
      // 宽限记录还在、截止时间确实已到、最近提醒过（事件复查可能刚把他取消了）
      const record = (await this.store.tracked(groupId)).get(kick.qq)
      const now = this.now()
      const deadline = record?.graceUntil?.getTime()
      const remindedAt = record?.lastRemindedAt?.getTime()
      const verdict = fresh.verdicts.get(kick.qq)
      if (!record || deadline === undefined || deadline > now || remindedAt === undefined || now - remindedAt > REMIND_FRESH_MS
        || verdict?.decision !== 'deny') {
        result.kickSkipped++
        continue
      }
      // 实时复核：还在群里、是普通成员、不是机器人、不在保护名单
      const live = await this.platform.getMember(bot, groupId, kick.qq)
      if (!live || isProtected(live, this.protectedIds())) {
        result.kickSkipped++
        continue
      }
      const recordKick = async (note = '') => {
        result.kicked.push({ qq: kick.qq, name: kick.name })
        this.rosters.get(groupId)?.delete(kick.qq)
        await this.store.removeTracked(groupId, [kick.qq])
        const releasedBefore = (await this.store.groupState(groupId)).lastConfirmAt?.getTime() ?? 0
        const approved = deadline <= releasedBefore
        const fast = this.fastReasons().has(verdict.reason) ? `；${FAST_KICK}` : ''
        await this.store.audit('kick', groupId, kick.qq, `${reasonShort(verdict.reason)}${fast}${approved ? '' : `；${UNAPPROVED_KICK}`}${note}`)
      }
      try {
        await this.platform.kick(bot, groupId, kick.qq)
        await recordKick()
      } catch (error) {
        // 超时，之后又查不到他在群里：按已移出算，照样计入每小时上限和熔断窗口（多算是安全方向，DECISIONS 第 54 条）
        if (isOneBotTimeout(error) && !(await this.platform.getMember(bot, groupId, kick.qq))) {
          await recordKick('；LLBot 响应超时，之后查不到他在群里，按已移出算')
        } else {
          result.kickFailed++
          this.logger.warn('移出失败 群 %s 成员 %s：%s%s', groupId, maskId(kick.qq), errorText(error), isOneBotTimeout(error) ? TIMEOUT_SUFFIX : '')
        }
      }
      const base = this.options.kickDelayMs ?? 3000
      await this.pause(base + Math.random() * base, signal)
    }
    if (result.kicked.length && this.config.kickAnnounce) {
      const list = result.kicked.map((k) => k.name).join('、')
      const text = fillTemplate(this.config.kickAnnounceTemplate, { list, url: this.bindUrl() })
      for (const part of splitMessage(text)) {
        try {
          await this.platform.sendGroup(bot, groupId, h.text(part))
        } catch (error) {
          // 不重发：超时的其实可能已经发出去了（K11）
          this.logger.warn('发送移出公告失败 群 %s：%s%s', groupId, errorText(error), isOneBotTimeout(error) ? TIMEOUT_SUFFIX : '')
          break
        }
      }
    }
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

  async handleJoinRequest(bot: Bot, req: { flag: string; groupId: string; qq: string; comment: string; invitorId: string | null }, source = '入群申请', catchUp = false) {
    this.pruneMaps()
    const g = this.group(req.groupId)
    if (!g) return // 不在受管群列表里的群一律不管（R6）
    if (this.handledFlags.has(req.flag)) return
    // 补处理拿到的编号和实时事件的不一样；同一个人刚处理过就跳过
    const personKey = `${g.groupId}:${req.qq}`
    if (catchUp && this.handledFlags.has(personKey)) return
    this.handledFlags.set(req.flag, this.now())
    this.handledFlags.set(personKey, this.now())
    const state = await this.store.groupState(g.groupId)
    const info = this.modeInfo(g.groupId, state)
    if (info.effective === 'off') return
    const label = this.groupLabel(g.groupId)
    const who = `${req.qq}${req.invitorId ? `（由 ${req.invitorId} 邀请）` : ''}`
    // 这一次没处理成（暂停中、AA 无法判断）：不记「处理过」，恢复后的补处理还能按规则处理它
    const later = (when: string) => {
      this.handledFlags.delete(req.flag)
      this.handledFlags.delete(personKey)
      this.retryJoin.add(personKey)
      return this.config.catchUpRequests ? `（${when}还没人处理的话，会按规则自动补处理）` : ''
    }
    this.retryJoin.delete(personKey)

    if (this.paused) {
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}。插件暂停中，留给管理员处理${later('恢复后')}。`)
      return
    }
    if (req.invitorId && this.config.inviteHandling === 'manual') {
      this.notifier.push(`📥 ${source}：${who} 被邀请加入 ${label}。按设置，邀请入群留给管理员处理。`)
      return
    }

    const result = await this.aa.claim(req.qq, req.comment, g.groupId, { signal: this.signal, retryDelays: [2000] })
    if (!result.ok) {
      if (result.kind === 'aborted') {
        later('')
        return
      }
      this.noteAaFailure(result, `入群申请 ${label}`)
      if (result.error === 'unknown_group') await this.refreshGroups()
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}。AA 无法判断（${describeFailure(result)}），留给管理员处理${later('AA 恢复后')}。`)
      return
    }
    this.noteAaOk()
    const verdict = result.verdict
    const outcomeText = result.claimed ? '验证码验证成功' : outcomeLabel(result.outcome)
    // 问 AA 的这段时间里可能暂停了或进入了冷静期：重新读一次
    if (this.paused || this.signal.aborted) {
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}。插件暂停中，留给管理员处理${later('恢复后')}。`)
      return
    }
    const nowInfo = this.modeInfo(g.groupId, await this.store.groupState(g.groupId))
    const failHint = (error: unknown) => (isOneBotTimeout(error) ? 'LLBot 响应超时，可能其实已经处理了，请在 QQ 里看一眼' : '可能已被管理员处理')

    if (verdict.decision === 'allow') {
      try {
        await this.platform.handleJoinRequest(bot, req.flag, true)
        this.approved.set(`${g.groupId}:${req.qq}`, { card: verdict.card, at: this.now() })
        await this.store.audit('approve', g.groupId, req.qq, outcomeText)
        this.notifier.push(`✅ ${source}：已同意 ${who} 加入 ${label}（${outcomeText}）。`)
      } catch (error) {
        this.notifier.push(`⚠ ${source}：${who} 申请加入 ${label}，AA 判定合格，但同意时出错（${failHint(error)}）：${errorText(error)}`)
      }
      return
    }

    if (verdict.decision === 'deny') {
      const reasonText = reasonShort(verdict.reason)
      const protectedQq = this.protectedIds().has(req.qq)
      // 补处理的申请和实时的一样处理（DECISIONS 第 45 条）；积压列表带了邀请人的，前面已经按「邀请入群」的设置处理过
      if (this.writeMode(nowInfo) && this.config.autoReject && !protectedQq) {
        const reason = fillTemplate(this.config.rejectTemplate, { hint: rejectHint(result.outcome, verdict.reason), url: this.bindUrl() }).slice(0, REJECT_REASON_MAX)
        try {
          await this.platform.handleJoinRequest(bot, req.flag, false, reason)
          await this.store.audit('reject', g.groupId, req.qq, `${reasonText}；${outcomeText}`)
          this.notifier.push(`🚫 ${source}：已拒绝 ${who} 加入 ${label}（${reasonText}；${outcomeText}）。`)
        } catch (error) {
          this.notifier.push(`⚠ ${source}：${who} 申请加入 ${label}，AA 判定不合格，但拒绝时出错（${failHint(error)}）：${errorText(error)}`)
        }
        return
      }
      const why = protectedQq ? '这个 QQ 在白名单里'
        : nowInfo.cooling && (nowInfo.effective === 'remind' || nowInfo.effective === 'enforce') ? '这个群在冷静期'
          : this.writeMode(nowInfo) ? '自动拒绝已关闭'
            : `群模式是 ${nowInfo.effective}`
      this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}，AA 判定不合格（${reasonText}；${outcomeText}）。${why}，留给管理员处理。`)
      return
    }

    const why = verdict.decision === 'review' ? `需要人工处理（${reasonShort(verdict.reason)}）` : 'AA 的结果无法识别'
    this.notifier.push(`📥 ${source}：${who} 申请加入 ${label}，${why}，留给管理员处理。`)
  }

  /** 机器人重新上线：补处理掉线期间积压的入群申请（DECISIONS 第 13、45 条）。 */
  private async onBotStatus(changed: Bot) {
    if (changed.platform !== 'onebot' || changed.status !== Universal.Status.ONLINE) return
    const bot = this.pickBot()
    if (!bot || bot.selfId !== changed.selfId) return
    this.checkOneBotConfig(bot)
    if (this.config.catchUpRequests) await this.catchUpRequests(bot)
    if (!this.lastRound) this.requestPatrol()
  }

  /**
   * 补处理还挂着的入群申请，规则和实时申请完全一样（该同意的同意、该拒绝的拒绝）。
   * 在这些时候运行：插件启动、机器人重新上线、AA 恢复连接、解除暂停。已经有人处理过的申请 QQ 会标成已处理，不会重复。
   */
  async catchUpRequests(bot: Bot, onlyRetry = false) {
    if (!this.groupsLoaded || this.paused || this.catchUpBusy) return
    this.catchUpBusy = true
    try {
      let pending
      try {
        pending = await this.platform.pendingJoinRequests(bot)
      } catch (error) {
        this.logger.warn('补拉入群申请失败（%s）：%s', isOneBotTimeout(error) ? ONEBOT_TIMEOUT_HINT : 'LLBot 可能不支持 get_group_system_msg', errorText(error))
        return
      }
      // AA 恢复、解除暂停时只补处理当初因为暂停或 AA 故障没处理成的申请，已经留给管理员的不再重复通知
      if (onlyRetry) pending = pending.filter((req) => this.retryJoin.has(`${req.groupId}:${req.qq}`))
      for (const req of pending) {
        if (this.signal.aborted || this.paused) return
        await this.handleJoinRequest(bot, req, '补处理的入群申请', true)
        await sleep(1000, this.signal)
      }
    } finally {
      this.catchUpBusy = false
    }
  }

  /** 在后台补处理一次积压的申请（AA 恢复连接、解除暂停时）。 */
  private catchUpSoon() {
    if (!this.config.catchUpRequests) return
    this.safely('补处理积压的入群申请', async () => {
      const bot = this.pickBot()
      if (bot) await this.catchUpRequests(bot, true)
    })
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
      // 刚由机器人同意的申请：AA 已经判过 allow，只需要设名片（新人一定是普通成员）
      if (this.writeMode(info) && this.config.syncCards && approved.card && member.card !== approved.card
        && canEditCard(botRole, member) && !isProtected(member, this.protectedIds())) {
        try {
          await this.platform.setCard(bot, groupId, qq, approved.card)
          member.card = approved.card
        } catch (error) {
          this.logger.warn('给新成员设名片失败：%s%s', errorText(error), isOneBotTimeout(error) ? TIMEOUT_SUFFIX : '')
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
    await this.migrated
    // 刚启动、还没巡检过这个群时没有名单缓存：先取一次真实人数，不然阈值会被当成 1（DECISIONS 第 57 条）
    let groupSize = roster?.size ?? 0
    if (!groupSize) {
      try {
        const members = await this.platform.listMembers(bot, groupId)
        this.rosters.set(groupId, new Map(members.map((m) => [m.qq, m])))
        groupSize = members.length
      } catch {}
    }
    const now = this.now()
    const plan = planGroup({
      groupId,
      mode: info.effective,
      cooling: this.coolingOf(state),
      releasedBefore: state.lastConfirmAt?.getTime() ?? 0,
      partial: true,
      groupSize: groupSize || 1,
      members: [member],
      verdicts: result.verdicts,
      tracked: await this.store.tracked(groupId),
      protectedIds: this.protectedIds(),
      selfIds: this.platform.allSelfIds(),
      refusedCards: refusedCards(await this.store.cardNotes(groupId)),
      botRole,
      now,
      settings: this.planSettings(0, false),
    })
    // 新人也按时间窗口累计：最近开始处置的人已经很多时，进入冷静期（DECISIONS 第 46 条）。
    // 取不到群人数时不据此进入冷静期（阈值不可信），这一轮只记录
    if (groupSize) await this.applyBreaker(groupId, plan, state, now)
    else if (plan.breaker === 'trip') plan.writes = false
    await this.applyPlan(bot, groupId, plan, this.signal)
    const verdict = result.verdicts.get(qq)!
    const name = this.who(member, qq)
    if (verdict.decision === 'allow') {
      this.notifier.push(`👋 ${label} 新成员 ${name}：合格。`)
      return
    }
    const fast = plan.writes && plan.fastRemind.some((r) => r.qq === qq)
    if (fast) {
      await this.sendFastReminders(bot, groupId, info.effective, plan)
    } else if (plan.writes && plan.newDenies.length) {
      await this.sendReminder(bot, groupId, info.effective, plan.track.filter((t) => t.qq === qq), 'newcomer')
    }
    const action = fast ? '已不具备成员资格，已马上提醒'
      : plan.writes ? '已开始宽限并提醒'
      : plan.breaker === 'trip' ? '这个群进入冷静期，只记录'
        : info.cooling && (info.effective === 'remind' || info.effective === 'enforce') ? '这个群在冷静期，只记录'
        : plan.noRole ? '机器人不是群主或管理员，只记录'
          : `群模式 ${info.effective}，只报告`
    this.notifier.push(`👋 ${label} 新成员 ${name}：${verdict.decision === 'deny' ? `不合格（${reasonShort(verdict.reason)}），${action}` : verdict.decision === 'review' ? `需人工处理（${reasonShort(verdict.reason)}）` : 'AA 无法判断'}。`)
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
      const cursor = await this.store.getKv<number>(this.cursorKey)
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
      if (last !== cursor) await this.store.setKv(this.cursorKey, last)
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
    await this.store.setKv(this.cursorKey, last)
    this.requestPatrol()
  }

  /** 按群合并复查一批 QQ（每个群只发一次 check）。返回是否全部处理完。 */
  async recheck(qqs: string[]): Promise<boolean> {
    const bot = this.pickBot()
    if (!bot) return false
    await this.migrated
    const sections: string[] = []
    const afters: Array<() => Promise<void>> = []
    for (const g of this.groups) {
      let state = await this.store.groupState(g.groupId)
      const mode = this.desiredMode(g.groupId)
      if ((mode === 'report' || mode === 'off') && state.holdSince) state = await this.clearCooling(g.groupId, mode)
      if (mode === 'off') continue
      // 每次都取最新的成员名单（身份可能变了：刚被设为管理员的人不能被加标记）
      let roster: Map<string, Member>
      try {
        const members = await this.platform.listMembers(bot, g.groupId)
        roster = new Map(members.map((m) => [m.qq, m]))
        this.rosters.set(g.groupId, roster)
      } catch {
        continue // 机器人不在这个群里；巡检会报告
      }
      const inGroup = qqs.filter((qq) => roster.has(qq))
      if (!inGroup.length) continue
      const members = inGroup.map((qq) => roster.get(qq)!)
      const verdicts = new Map<string, Verdict>()
      for (const part of chunk(inGroup, MAX_CHECK)) {
        const result = await this.aa.check(g.groupId, part, false, { signal: this.signal, retryDelays: this.options.retryDelays })
        if (!result.ok) {
          if (result.kind === 'aborted') return false
          this.noteAaFailure(result, `复查 ${this.groupLabel(g.groupId)}`)
          if (result.error === 'unknown_group') await this.refreshGroups()
          // 暂时性故障（网络、超时、5xx）：游标不前进，下次重来。
          // 确定性故障（4xx 等）重来也没用，跳过这个群，交给定时巡检，不能卡住所有群的变化处理。
          if (result.retryable) return false
          break
        }
        for (const [qq, verdict] of result.verdicts) verdicts.set(qq, verdict)
      }
      if (verdicts.size !== inGroup.length) continue
      const botRole = roster.get(bot.selfId)?.role ?? null
      const now = this.now()
      const notes = await this.store.cardNotes(g.groupId)
      const plan = planGroup({
        groupId: g.groupId,
        mode,
        cooling: this.coolingOf(state),
        releasedBefore: state.lastConfirmAt?.getTime() ?? 0,
        partial: true,
        groupSize: roster.size,
        members,
        verdicts,
        tracked: await this.store.tracked(g.groupId),
        protectedIds: this.protectedIds(),
        selfIds: this.platform.allSelfIds(),
        refusedCards: refusedCards(notes),
        botRole,
        now,
        settings: this.planSettings(0, false),
      })
      // 局部复查只可能进入冷静期（trip），不会结束冷静期
      await this.applyBreaker(g.groupId, plan, state, now)
      const applied = await this.applyPlan(bot, g.groupId, plan, this.signal)
      await this.sendFastReminders(bot, g.groupId, mode, plan)
      const report = await this.adminCardReport(g.groupId, plan, applied, members, verdicts, notes, false)
      const changed = plan.newDenies.length || plan.untrack.length || applied.cardsOk || report.lines.length
      if (changed) {
        const head = [`▶ ${this.groupLabel(g.groupId)}　${MODE_TEXT[mode]}`]
        if (plan.breaker === 'trip') head.push(this.coolingLine(plan.breakerReason, now))
        else if (plan.breaker === 'cooling' && state.holdSince) head.push(this.coolingLine(state.holdNote, state.holdSince.getTime()))
        sections.push(this.renderSection(head, plan, applied, members, mode, report.lines, []))
        afters.push(() => this.commitAdminCards(g.groupId, report))
      }
    }
    if (sections.length) this.notifier.push(`【AA 变化复查】\n\n${sections.join('\n\n')}`)
    for (const after of afters) {
      try {
        await after()
      } catch (error) {
        this.logger.warn('保存管理员名片记录出错：%s', error)
      }
    }
    return true
  }

  // ------------------------------------------------------------ 每日提醒

  async runReminders(): Promise<void> {
    if (this.remindBusy || this.paused) return
    this.remindBusy = true
    try {
      const bot = this.pickBot()
      if (!bot) return
      await this.migrated
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
        // 只提醒处置过的人（只记录的人不提醒，K4）
        const targets = [...tracked.values()].filter((r) => r.activeSince && roster.has(r.qq)).map((r) => r.qq)
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
          cooling: null, // 冷静中的群在上面 writeMode 已经跳过
          releasedBefore: state.lastConfirmAt?.getTime() ?? 0,
          partial: true,
          groupSize: members.length,
          members: targets.map((qq) => roster.get(qq)!),
          verdicts: result.verdicts,
          tracked,
          protectedIds: this.protectedIds(),
          selfIds: this.platform.allSelfIds(),
          refusedCards: refusedCards(await this.store.cardNotes(g.groupId)),
          botRole: roster.get(bot.selfId)?.role ?? null,
          now: this.now(),
          settings: this.planSettings(0, false),
        })
        await this.applyPlan(bot, g.groupId, plan, this.signal)
        if (!plan.writes) continue
        // 群主 / 管理员单独一条提醒（没有截止时间，DECISIONS 第 51 条）
        const staff = new Set(plan.denies.filter((d) => d.staff).map((d) => d.qq))
        const fast = new Set(plan.fastRemind.map((r) => r.qq))
        const rows = plan.track.filter((r) => r.activeSince && !fast.has(r.qq))
        await this.sendFastReminders(bot, g.groupId, info.effective, plan)
        const normal = await this.sendReminder(bot, g.groupId, info.effective, rows.filter((r) => !staff.has(r.qq)), 'daily')
        const admins = await this.sendReminder(bot, g.groupId, info.effective, rows.filter((r) => staff.has(r.qq)), 'daily', true)
        const sent = { sent: normal.sent + admins.sent, failed: normal.failed + admins.failed, timedOut: normal.timedOut || admins.timedOut }
        const label = this.groupLabel(g.groupId)
        if (sent.sent) this.notifier.push(`⏰ ${label} 已提醒 ${sent.sent} 人`)
        if (sent.failed) {
          this.notifier.push(`⚠ ${label} 提醒没有发出去（${sent.failed} 人），没有记提醒时间，这些人不会因此被移出${sent.timedOut ? '；LLBot 响应超时，群里可能其实已经看到了' : ''}`)
        }
      }
      await this.scheduleFastKicks()
    } finally {
      this.remindBusy = false
    }
  }

  /**
   * 在群里 @ 提醒（每条最多 20 人，文字太长时再对半拆，每条不超过 1500 字）。
   * enforce 模式下，第一次成功提醒某人时才定下他的截止时间（现在 + 宽限期），保证每个人被移出前都收到过带截止时间的提醒。
   * 发送失败不重发（超时的其实可能已经发出去了），也不记提醒时间：没收到提醒的人不会被移出。
   */
  async sendReminder(bot: Bot, groupId: string, mode: Mode, rows: TrackedMember[], source: 'daily' | 'newcomer' | 'fast' = 'daily', staff = false):
    Promise<{ sent: number; failed: number; timedOut: boolean; reminded: TrackedMember[] }> {
    const outcome = { sent: 0, failed: 0, timedOut: false, reminded: [] as TrackedMember[] }
    if (!rows.length) return outcome
    // 群主 / 管理员：单独的文字，没有截止时间（永远不移出）
    const withDeadline = mode === 'enforce' && !staff
    const fast = source === 'fast' && !staff
    const template = staff ? (this.config.adminRemindTemplate ?? this.config.remindTemplate)
      : mode === 'enforce' ? (fast ? this.config.fastTemplate ?? this.config.warnTemplate : this.config.warnTemplate) : this.config.remindTemplate
    // 截止时间：离开联盟的人是「现在 + 快速宽限」，原来的截止时间更早就保留原来的（DECISIONS 第 52 条）；其他人第一次提醒时定下
    const deadlineFor = (row: TrackedMember, now: number): Date | null => {
      if (!withDeadline) return null
      if (fast) {
        const at = now + (this.config.fastGraceHours ?? 2) * 3600_000
        return row.graceUntil && row.graceUntil.getTime() <= at ? row.graceUntil : new Date(at)
      }
      return row.graceUntil ?? new Date(now + this.config.graceHours * 3600_000)
    }
    const url = this.bindUrl()
    const [beforeList, ...rest] = template.split('{list}')
    const head = fillTemplate(beforeList, { url })
    const tail = rest.length ? fillTemplate(rest.join('{list}'), { url }) : ''
    const entryText = (row: TrackedMember, now: number) => {
      const graceUntil = deadlineFor(row, now)
      // 已经过了截止时间的人（例如一直没能移出）：不再说「请在截止时间前」（DECISIONS 第 58 条）
      const deadline = !graceUntil ? '' : graceUntil.getTime() <= now ? '，已过截止时间，下一次处理时会被移出' : `，截止 ${formatDeadline(graceUntil.getTime())}`
      return `（${reasonShort(row.reason)}${deadline}）\n`
    }
    const estimate = (part: TrackedMember[]) => charLength(head) + charLength(tail)
      + part.reduce((sum, row) => sum + AT_CHARS + charLength(entryText(row, this.now())), 0)
    // 每批最多 20 人；一条消息估算超过上限就再对半拆
    const queue = chunk(rows, REMIND_CHUNK)
    const batches: TrackedMember[][] = []
    while (queue.length) {
      const part = queue.shift()!
      if (part.length > 1 && estimate(part) > MAX_MESSAGE_CHARS) {
        const mid = Math.ceil(part.length / 2)
        queue.unshift(part.slice(0, mid), part.slice(mid))
        continue
      }
      batches.push(part)
    }
    const what = source === 'daily' ? '每日提醒' : source === 'fast' ? '离开联盟提醒' : '新人提醒'
    for (const part of batches) {
      if (!(await this.stillWritable(groupId, this.signal))) break
      const now = this.now()
      const updated = part.map((row) => ({ ...row, graceUntil: deadlineFor(row, now), lastRemindedAt: new Date(now) }))
      const content: Fragment[] = [h.text(head)]
      for (const row of updated) content.push(h.at(row.qq), h.text(entryText(row, now)))
      if (tail) content.push(h.text(tail))
      try {
        await this.platform.sendGroup(bot, groupId, content as any)
      } catch (error) {
        outcome.failed += part.length
        if (isOneBotTimeout(error)) outcome.timedOut = true
        this.logger.warn('发送提醒失败 群 %s：%s%s', groupId, errorText(error), isOneBotTimeout(error) ? TIMEOUT_SUFFIX : '')
        continue
      }
      await this.store.markReminded(groupId, updated)
      outcome.sent += part.length
      outcome.reminded.push(...updated)
      this.logger.info('已在群 %s 提醒 %d 人（%s）', groupId, part.length, what)
      await this.store.audit('remind', groupId, '', `${part.length} 人（${what}）`)
    }
    return outcome
  }

  // ------------------------------------------------------------ 离开联盟：马上提醒、到点移出（DECISIONS 第 52 条）

  /** 这一轮发现的「离开联盟」的人马上提醒，运维群每人一行 ⚡，然后重新安排到期检查。 */
  private async sendFastReminders(bot: Bot, groupId: string, mode: Mode, plan: Plan) {
    if (!plan.writes || !plan.fastRemind.length) return
    const result = await this.sendReminder(bot, groupId, mode, plan.fastRemind, 'fast')
    const label = this.groupLabel(groupId)
    const roster = this.rosters.get(groupId)
    const lines = result.reminded.map((row) => {
      const who = this.who(roster?.get(row.qq), row.qq)
      const when = mode === 'enforce' && row.graceUntil ? `，${formatDeadline(row.graceUntil.getTime())} 移出` : ''
      return `⚡ ${label} ${who} 已不具备成员资格（${reasonShort(row.reason)}），已提醒${when}`
    })
    if (lines.length) this.notifier.push(lines.join('\n'))
    if (result.failed) {
      this.notifier.push(`⚠ ${label} 离开联盟的提醒没有发出去（${result.failed} 人），没有定截止时间，下一次复查或巡检时再试${result.timedOut ? '；LLBot 响应超时，群里可能其实已经看到了' : ''}`)
    }
    await this.scheduleFastKicks()
  }

  /** 按最早的一个「离开联盟」截止时间安排到期检查（插件启动、定下截止时间、解除暂停时调用）。 */
  async scheduleFastKicks() {
    const next = await this.store.nextDeadline(this.fastReasons(), this.now())
    this.nextFastKickAt = next
    if (this.options.timers === false || this.signal.aborted) return
    if (next === null) {
      this.timers.get('fastKick')?.()
      this.timers.delete('fastKick')
      return
    }
    // 到点后 1 秒内检查（最多晚 1 分钟）
    this.schedule('fastKick', Math.max(0, next - this.now()) + 1000, () => this.fastKickTick())
  }

  private async fastKickTick() {
    let result: 'busy' | 'done' = 'done'
    try {
      result = await this.runFastKicks()
    } finally {
      // 正在巡检等原因没能检查：1 分钟后再试；否则按下一个截止时间安排
      if (result === 'busy') this.schedule('fastKick', 60_000, () => this.fastKickTick())
      else await this.scheduleFastKicks()
    }
  }

  /**
   * 到期检查：「离开联盟」截止时间已到的人，不等巡检就处理。复核和巡检里的移出完全一样：
   * 暂停、冷静期、再问一次 AA、实时查身份、36 小时内提醒过、每小时上限、熔断的时间窗口。
   * 没能移出的（AA 连不上等）不重试刷屏，下一次巡检照常按规则处理。
   */
  async runFastKicks(): Promise<'busy' | 'done'> {
    if (this.paused) return 'done'
    if (this.fastBusy || this.patrolRunning) return 'busy'
    const bot = this.pickBot()
    if (!bot) return 'done'
    this.fastBusy = true
    try {
      await this.migrated
      const reasons = this.fastReasons()
      for (const g of this.groups) {
        if (this.signal.aborted || this.paused) break
        if (this.desiredMode(g.groupId) !== 'enforce') continue
        const now = this.now()
        const tracked = await this.store.tracked(g.groupId)
        const due = [...tracked.values()].filter((r) => r.graceUntil && r.graceUntil.getTime() <= now && reasons.has(r.reason))
        if (!due.length) continue
        let members: Member[]
        try {
          members = await this.platform.listMembers(bot, g.groupId)
        } catch {
          continue
        }
        const roster = new Map(members.map((m) => [m.qq, m]))
        this.rosters.set(g.groupId, roster)
        const targets = due.map((r) => roster.get(r.qq)).filter((m): m is Member => !!m)
        if (!targets.length) continue
        const result = await this.aa.check(g.groupId, targets.map((m) => m.qq), false, { signal: this.signal, retryDelays: [] })
        if (!result.ok) {
          if (result.kind !== 'aborted') this.noteAaFailure(result, `离开联盟到期处理 ${this.groupLabel(g.groupId)}`)
          continue
        }
        this.noteAaOk()
        const state = await this.store.groupState(g.groupId)
        const kicksLastHour = await this.store.countAudit('kick', g.groupId, new Date(now - 3600_000))
        const recentKicks = await this.store.auditSince('kick', g.groupId, this.kickWindowStart(state, now))
        const plan = planGroup({
          groupId: g.groupId,
          mode: 'enforce',
          cooling: this.coolingOf(state),
          releasedBefore: state.lastConfirmAt?.getTime() ?? 0,
          recentUnapprovedKicks: recentKicks.filter((row) => row.detail.includes(UNAPPROVED_KICK)).length,
          partial: true,
          groupSize: members.length,
          members: targets,
          verdicts: result.verdicts,
          tracked,
          protectedIds: this.protectedIds(),
          selfIds: this.platform.allSelfIds(),
          refusedCards: refusedCards(await this.store.cardNotes(g.groupId)),
          botRole: roster.get(bot.selfId)?.role ?? null,
          now,
          settings: this.planSettings(Math.max(0, this.config.kickPerHour - kicksLastHour), true),
        })
        // 一次到期的人太多（按时间窗口累计）：进入冷静期，这一批一个都不移出
        await this.applyBreaker(g.groupId, plan, state, now)
        const applied = await this.applyPlan(bot, g.groupId, plan, this.signal)
        if (applied.kicked.length && state.lastRosterSize > 0) {
          await this.store.setGroupState(g.groupId, { lastRosterSize: Math.max(0, state.lastRosterSize - applied.kicked.length) })
        }
        if (applied.kicked.length || applied.kickSkipped || applied.kickFailed || plan.kicksDeferred || plan.breaker !== 'none') {
          const head = [`▶ ${this.groupLabel(g.groupId)}　${MODE_TEXT.enforce}`]
          if (plan.breaker === 'trip') head.push(this.coolingLine(plan.breakerReason, now))
          else if (plan.breaker === 'cooling' && state.holdSince) head.push(this.coolingLine(state.holdNote, state.holdSince.getTime()))
          this.notifier.push(`【离开联盟到期处理】\n\n${this.renderSection(head, plan, applied, targets, 'enforce', [], [])}`)
        }
      }
      return 'done'
    } finally {
      this.fastBusy = false
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
      this.catchUpSoon()
      await this.scheduleFastKicks()
    }
  }

  /**
   * aaqq.confirm：提前结束冷静等待（可选）。马上巡检这个群，仍按同样的规则判断能不能继续：
   * 和冷静开始时还是同一批人就继续，变化很大会重新冷静（不跳过检查）。
   */
  async confirm(groupId: string, actor: string): Promise<string> {
    const g = this.group(groupId)
    if (!g) return `${groupId} 不是 AA 上的受管群。`
    const label = this.groupLabel(groupId)
    const state = await this.store.groupState(groupId)
    if (!state.holdSince) return `${label} 现在不在冷静期。0.2.0 起改模式直接生效，不需要确认。`
    const since = Math.min(state.holdSince.getTime(), this.now() - this.cooldownMs())
    await this.store.setGroupState(groupId, { holdSince: new Date(since) })
    await this.store.audit('cool-skip', groupId, '', '', actor)
    this.requestPatrol([groupId])
    const paused = this.paused ? '（插件暂停中，恢复后才会巡检）' : ''
    return `已提前结束 ${label} 的冷静等待，马上巡检${paused}；情况和冷静开始时一样就继续处置，变化很大会重新冷静`
  }

  async statusText(): Promise<string> {
    await this.migrated
    const lines: string[] = []
    lines.push(`状态：${this.paused ? '⏸ 暂停中' : '▶ 运行中'}`)
    const { bot, problem } = this.platform.pickBot()
    lines.push(`机器人：${bot ? `${bot.selfId} 在线` : `❌ ${problem}`}`)
    lines.push(`AA：${this.aaDown ? '❌ 最近一次请求失败' : '正常'}${this.aa.clockSkewMs !== null ? `（时间差 ${Math.round(this.aa.clockSkewMs / 1000)} 秒）` : ''}`)
    if (this.adminGroupConflict) lines.push('❌ 运维群同时是受管群，已停止发送运维通知，请修改配置')
    const badWhitelist = this.invalidWhitelist()
    if (badWhitelist.length) lines.push(`⚠ 白名单里有 ${badWhitelist.length} 条写得不对，没有生效：${badWhitelist.join('、')}`)
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
        const mode = this.desiredMode(g.groupId)
        const tracked = await this.store.tracked(g.groupId)
        const extra: string[] = []
        if (state.holdSince) extra.push(`冷静中，约 ${formatShortTime(state.holdSince.getTime() + this.cooldownMs())} 之后的巡检决定`)
        if (tracked.size) {
          const active = [...tracked.values()].filter((r) => r.activeSince).length
          extra.push(`已记录不合格 ${tracked.size} 人（其中已处置 ${active} 人）`)
        }
        lines.push(`· ${this.groupLabel(g.groupId)}：${MODE_TEXT[mode]}${extra.length ? `（${extra.join('，')}）` : ''}`)
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

/** 名片记录里被 QQ 拒过的：QQ → 那张 AA 名片（同一张不再重试）。 */
function refusedCards(notes: Map<string, CardNote>): Map<string, string> {
  const result = new Map<string, string>()
  for (const [qq, note] of notes) if (note.why === 'refused') result.set(qq, note.card)
  return result
}

/** 最多列 15 行，其余写「另外 N 人」。 */
function limitList(lines: string[]): string[] {
  if (lines.length <= REPORT_LIST_MAX) return lines
  return [...lines.slice(0, REPORT_LIST_MAX), `· ……另外 ${lines.length - REPORT_LIST_MAX} 人`]
}

/**
 * 报告里的一个分类：标题（带人数），每人一行 `· 名字(QQ)`；有 group 时按它归组，组名用【】写一次。
 * 最多列 15 人，其余写「另外 N 人」。
 */
function listSection(title: string, items: Array<{ text: string; group?: string }>): string {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const key = item.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item.text)
  }
  const lines = [title]
  let shown = 0
  for (const [group, texts] of groups) {
    if (shown >= REPORT_LIST_MAX) break
    if (group) lines.push(`【${group}】`)
    for (const text of texts) {
      if (shown >= REPORT_LIST_MAX) break
      lines.push(`· ${text}`)
      shown++
    }
  }
  if (items.length > shown) lines.push(`· ……另外 ${items.length - shown} 人`)
  return lines.join('\n')
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
