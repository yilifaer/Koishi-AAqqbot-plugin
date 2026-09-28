// 发到运维群的通知：短时间内的多条合并成一条、全局限速、发送失败只记日志（交接文档 R18；被 QQ 拒收的除外，见下）。
// 所有内容都按纯文本发送（h.text），名片、群名、错误信息里的 <at> 之类不会被当成消息元素。
//
// 超时和其他失败都不自动重发（运维通知、群里的提醒和公告都一样，DECISIONS 第 41 条）：
// LLBot 响应超时的那一条其实可能已经送达，重发会刷屏。只有明确被 QQ 拒收（没发出去）的才拆小重发。
// 每条消息不超过 1500 字；一份通知太长时在空行 / 换行处分成几条，每条开头带（1/N）序号（DECISIONS 第 43 条）。
// 带名单（「名字(QQ号)」）的消息每条最多 20 行名单、约 800 字；被 QQ 拒收时对半拆开重发，
// 单独一行还被拒才把名字隐藏（DECISIONS 第 62 条）。超时的照旧不重发。

import { h, Logger } from 'koishi'
import { classifySendError, describeSplit, hideNames, renderLines, SendResult, sendSplitting, textLines } from './delivery'
import type { Platform } from './platform'
import {
  charLength, countListLines, fitsLimits, ListLimits, MAX_LIST_CHARS, MAX_LIST_LINES, MAX_MESSAGE_CHARS, normalizeId, splitMessage,
} from './util'

export { HIDDEN_NAME, hideNames } from './delivery'

const MAX_MESSAGES_PER_HOUR = 30
const FLUSH_DELAY_MS = 3000
/** 给「之前有 N 条没发出」的说明留出位置。 */
const PACK_LIMIT = MAX_MESSAGE_CHARS - 40
const LIST_LIMITS: ListLimits = { lines: MAX_LIST_LINES, chars: MAX_LIST_CHARS - 40 }
const LOST_REASON: Partial<Record<SendResult, string>> = {
  capped: '超过每小时上限',
  failed: '发送失败',
  refused: '被 QQ 拒收，没法再拆',
  skipped: '没有发',
}

export class Notifier {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private sentAt: number[] = []
  private dropped = 0
  /** 一次只做一轮发送：上一轮还没发完（拆开重发、LLBot 很慢）时，下一轮排在后面，拆出来的几段之间不会插进别的通知。 */
  private flushing: Promise<void> = Promise.resolve()
  /** 测试用：记录发出的每条消息。 */
  history: string[] = []

  constructor(
    private platform: Platform,
    private logger: Logger,
    private getAdminGroup: () => string | null,
    private now: () => number = Date.now,
  ) {}

  /** 排队一条通知；几秒内的通知合并发送。 */
  push(text: string) {
    this.logger.info('%s', text.replace(/\n+/g, ' | '))
    if (!this.getAdminGroup()) return
    this.queue.push(text)
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }

  /** 马上发出排着的通知（上一轮还没发完就排在它后面）。 */
  flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushNow())
    this.flushing = run.catch(() => {})
    return run
  }

  private async flushNow() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const items = this.queue.splice(0)
    if (!items.length) return
    const groupId = this.getAdminGroup()
    if (!groupId) return
    for (const message of pack(items)) {
      await this.deliver(groupId, message)
    }
  }

  /** 发一条消息；被 QQ 拒收时对半拆开重发，单独一行还被拒才隐藏名字（DECISIONS 第 62 条）。 */
  private async deliver(groupId: string, text: string) {
    const { label, lines } = textLines(text)
    const flat = (part: string[]) => renderLines(part, '').replace(/\n+/g, ' | ')
    const report = await sendSplitting(lines, (part, sub) => this.sendOne(groupId, renderLines(part, sub)), {
      label,
      hide: hideNames,
      // 拆出来的那段没发出去：写明是哪一段、内容是什么（整条没拆就没发出的，push 时已经写过日志）
      onLost: (part, sub, why) => {
        if (sub === label && why !== 'refused') return
        this.logger.warn('运维通知（%s）没有发出（%s），只写日志：%s', sub || '1/1', LOST_REASON[why] ?? why, flat(part))
      },
      onHidden: (line, sub, result) => {
        this.logger.warn('运维通知（%s）这一行隐藏名字后发出%s：%s', sub || '1/1', result === 'timeout' ? '（LLBot 响应超时，可能已经送达）' : '', flat([line]))
      },
    })
    if (!report.split) return
    const which = label ? `（${label}）` : `「${Array.from(lines[0] ?? '').slice(0, 20).join('')}…」`
    this.logger.warn('运维通知%s%s', which, describeSplit(report))
  }

  /** 发出一条消息（计入每小时上限）。拒收、失败、超时都不在这里重发。 */
  private async sendOne(groupId: string, text: string): Promise<SendResult> {
    const now = this.now()
    this.sentAt = this.sentAt.filter((t) => now - t < 3600_000)
    if (this.sentAt.length >= MAX_MESSAGES_PER_HOUR) {
      this.dropped++
      this.logger.warn('运维通知超过每小时 %d 条的上限，这条只写日志', MAX_MESSAGES_PER_HOUR)
      return 'capped'
    }
    const { bot, problem } = this.platform.pickBot()
    if (!bot) {
      this.logger.warn('运维通知没有发出：%s', problem)
      return 'failed'
    }
    // 「之前有 N 条没发出」的说明：先认领（同时进行的另一条不会重复带上），确定没发出去再还回去
    const dropped = this.dropped
    this.dropped = 0
    if (dropped) text = `（之前有 ${dropped} 条通知因为限速没有发出，请看 Koishi 日志）\n${text}`
    this.sentAt.push(now)
    this.history.push(text)
    if (this.history.length > 50) this.history.shift()
    try {
      await this.platform.sendGroup(bot, groupId, h.text(text))
      return 'sent'
    } catch (error) {
      const kind = classifySendError(error)
      if (kind === 'timeout') {
        this.logger.warn('运维通知可能已经送达（LLBot 响应超时），不会重发')
      } else {
        this.dropped += dropped
        this.logger.warn('运维通知发送失败：%s', error)
      }
      return kind
    }
  }
}

/**
 * 把几条通知拼成若干条不超过上限的消息。
 * 短通知合并成一条（不加序号）；一份太长的通知单独切成几条，序号按这一份计（1/3、2/3、3/3）。
 * 带名单的消息另有上限（每条最多 20 行名单、约 800 字，DECISIONS 第 62 条），合并时也一样。
 */
export function pack(items: string[], limit = PACK_LIMIT, list: ListLimits = LIST_LIMITS): string[] {
  const messages: string[] = []
  let current = ''
  const flush = () => {
    if (current) messages.push(current)
    current = ''
  }
  for (const item of items) {
    const parts = splitMessage(item, limit, list)
    if (parts.length > 1) {
      flush()
      messages.push(...parts)
      continue
    }
    const piece = parts[0]
    const merged = `${current}\n\n${piece}`
    if (current && !fitsLimits(charLength(merged), countListLines(merged), limit, list)) flush()
    current = current ? `${current}\n\n${piece}` : piece
  }
  flush()
  return messages
}

/** 运维群号：规范化后返回；没填返回 null。 */
export function resolveAdminGroup(value: string): string | null {
  return normalizeId(value)
}
