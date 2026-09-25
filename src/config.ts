import { Schema } from 'koishi'

export type Mode = 'off' | 'report' | 'remind' | 'enforce'

export const MODE_RANK: Record<Mode, number> = { off: 0, report: 1, remind: 2, enforce: 3 }

export interface GroupModeEntry {
  groupId: string
  mode: Mode
}

export interface Config {
  // 连接 AA
  aaBaseUrl: string
  keyId: string
  secret: string
  timeoutSeconds: number
  bindUrl: string
  // 机器人与运维
  botId: string
  adminGroupId: string
  operators: string[]
  whitelist: string[]
  // 群模式
  defaultMode: Mode
  groupModes: GroupModeEntry[]
  // 入群申请
  autoReject: boolean
  rejectTemplate: string
  inviteHandling: 'same' | 'manual'
  catchUpRequests: boolean
  // 巡检与事件
  patrolIntervalHours: number
  eventPollSeconds: number
  // 群名片
  syncCards: boolean
  // 宽限、提醒与标记
  graceHours: number
  remindTime: string
  remindTemplate: string
  warnTemplate: string
  markCards: boolean
  markPrefix: string
  kickAnnounce: boolean
  kickAnnounceTemplate: string
  // 熔断
  breakerCount: number
  breakerPercent: number
  kickPerHour: number
}

const modeSchema = Schema.union([
  Schema.const('off' as const).description('off：不管这个群'),
  Schema.const('report' as const).description('report：只在运维群报告，群成员感觉不到'),
  Schema.const('remind' as const).description('remind：群里 @ 提醒 + 名片加标记，不踢'),
  Schema.const('enforce' as const).description('enforce：提醒 + 宽限期到了移出'),
])

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    aaBaseUrl: Schema.string().role('link').required()
      .description('AA 的网址，例如 `https://auth.example.com`。AA 装在子路径下时连子路径一起写，例如 `https://example.com/auth`。正式环境必须用 https。'),
    keyId: Schema.string().pattern(/^[\x21-\x7e]{1,64}$/).required()
      .description('密钥编号：AA 的 `local.py` 里 `QQBOT_API_KEYS` 的键，例如 `koishi-1`。只能用英文、数字和符号，不能有空格。'),
    secret: Schema.string().role('secret').required()
      .description('密钥：`QQBOT_API_KEYS` 里对应的值。只填在这里，不要发给任何人。'),
    timeoutSeconds: Schema.natural().min(5).max(120).default(30)
      .description('每次请求 AA 最多等多少秒。'),
    bindUrl: Schema.string().role('link').default('')
      .description('成员去绑定 QQ 的网址，会写进拒绝理由和提醒里。留空时使用「AA 的网址 + /services/」。'),
  }).description('连接 AA'),

  Schema.object({
    botId: Schema.string().default('')
      .description('用哪个机器人账号管理（填机器人的 QQ 号）。这个 Koishi 里只有一个 QQ 机器人时可以留空。'),
    adminGroupId: Schema.string().default('')
      .description('运维群号：巡检汇总、报警都发到这里。只放管理人员，**不能是被管理的群**。管理命令也只能在这个群里或私聊机器人时使用。'),
    operators: Schema.array(Schema.string()).role('table').default([])
      .description('运维名单（QQ 号）：只有名单里、并且 Koishi 权限等级 ≥ 3 的人能用管理命令。'),
    whitelist: Schema.array(Schema.string()).role('table').default([])
      .description('白名单（QQ 号）：这些人永远不会被提醒、改名片或移出。机器人自己、群主、群管理员已自动保护，不用填。'),
  }).description('机器人与运维'),

  Schema.object({
    defaultMode: modeSchema.default('report')
      .description('AA 上新加的群默认用哪种模式。'),
    groupModes: Schema.array(Schema.object({
      groupId: Schema.string().required().description('群号'),
      mode: modeSchema.default('report').description('模式'),
    })).role('table').default([])
      .description('单独设置某些群的模式。**升级到 remind 或 enforce 后，要等一轮巡检报告出来，由管理员发送 `aaqq.confirm 群号` 确认后才真正生效**；降级立即生效。'),
  }).description('群模式'),

  Schema.object({
    autoReject: Schema.boolean().default(true)
      .description('AA 明确判定不合格时自动拒绝入群申请（只在 remind / enforce 模式的群里）。关掉则留给管理员处理。AA 连不上、需要人工处理时永远不会拒绝。'),
    rejectTemplate: Schema.string().default('{hint}。绑定地址：{url}')
      .description('拒绝理由。`{hint}` 是自动生成的原因说明，`{url}` 是绑定网址。'),
    inviteHandling: Schema.union([
      Schema.const('same' as const).description('和普通申请一样问 AA'),
      Schema.const('manual' as const).description('一律留给管理员'),
    ]).default('same')
      .description('群成员邀请别人入群、需要审核时（申请里没有验证信息）怎么处理。'),
    catchUpRequests: Schema.boolean().default(true)
      .description('机器人重新上线时，补处理掉线期间还挂着的入群申请。'),
  }).description('入群申请'),

  Schema.object({
    patrolIntervalHours: Schema.natural().min(1).max(24).default(6)
      .description('每隔几小时巡检一次所有群（插件启动后会先巡检一次）。'),
    eventPollSeconds: Schema.natural().min(30).max(600).default(60)
      .description('每隔几秒向 AA 拉取一次变化（解绑、退组等），发现后立即复查相关的人。'),
    syncCards: Schema.boolean().default(true)
      .description('按 AA 算好的名片同步合格成员的群名片（只在 remind / enforce 模式的群里；成员自己改掉的会在下次巡检时改回）。'),
  }).description('巡检与群名片'),

  Schema.object({
    graceHours: Schema.natural().min(1).max(720).default(48)
      .description('enforce 模式下的宽限期：从第一次收到带截止时间的 @ 提醒开始算，过了时间还不合格才移出。移出前 36 小时内一定成功提醒过这个人。'),
    remindTime: Schema.string().pattern(/^\s*([01]?\d|2[0-3]):[0-5]\d\s*$/).default('19:30')
      .description('每天几点在群里 @ 提醒不合格的人（机器人电脑的本地时间，格式 `19:30`）。'),
    remindTemplate: Schema.string().role('textarea').default('以下成员还没有满足本群的要求，请尽快在联盟 AA 完成 QQ 绑定：{url}\n{list}')
      .description('remind 模式的提醒文字。`{list}` 是被 @ 的人和原因，`{url}` 是绑定网址。'),
    warnTemplate: Schema.string().role('textarea').default('以下成员还没有满足本群的要求，请在截止时间前在联盟 AA 完成 QQ 绑定，否则会被移出本群：{url}\n{list}')
      .description('enforce 模式的提醒文字。`{list}` 里会带上每个人的截止时间。'),
    markCards: Schema.boolean().default(true)
      .description('给不合格的人的群名片前面加标记（remind / enforce 模式）。合格后自动改成 AA 给的名片。'),
    markPrefix: Schema.string().default('【SPY】')
      .description('名片标记，例如 `【SPY】`，会加在原名片前面。'),
    kickAnnounce: Schema.boolean().default(true)
      .description('enforce 模式移出成员后，在该群里也发一条公告。'),
    kickAnnounceTemplate: Schema.string().role('textarea').default('以下成员因未满足本群的要求已被移出：{list}\n完成联盟 AA 绑定后可以重新申请入群：{url}')
      .description('移出公告。`{list}` 是被移出的人的名片。'),
  }).description('宽限、提醒与标记'),

  Schema.object({
    breakerCount: Schema.natural().min(1).max(100).default(5)
      .description('熔断人数：一轮里某个群新增的不合格人数超过这个数（或超过下面的比例，取较小者，但至少为 1）时，这个群这一轮什么都不做，只报警，等管理员发送 `aaqq.confirm 群号` 确认。'),
    breakerPercent: Schema.natural().min(1).max(100).default(10)
      .description('熔断比例（占群人数的百分比）。'),
    kickPerHour: Schema.natural().min(1).max(100).default(10)
      .description('每个群每小时最多移出几个人，超过的留到下一轮。'),
  }).description('防误踢（熔断）'),
]) as Schema<Config>
