// 发到运维群的通知：短时间内的多条合并成一条、全局限速、发送失败只记日志（交接文档 R18）。
// 所有内容都按纯文本发送（h.text），名片、群名、错误信息里的 <at> 之类不会被当成消息元素。
//
// 发送失败都不自动重发（运维通知、群里的提醒和公告都一样，DECISIONS 第 41 条）：
// LLBot 响应超时的那一条其实可能已经送达，重发会刷屏。
// 每条消息不超过 1500 字；一份通知太长时在空行 / 换行处分成几条，每条开头带（1/N）序号（DECISIONS 第 43 条）。

import { h, Logger } from 'koishi'
import type { Platform } from './platform'
import { charLength, isOneBotTimeout, MAX_MESSAGE_CHARS, normalizeId, splitMessage } from './util'

const MAX_MESSAGES_PER_HOUR = 30
const FLUSH_DELAY_MS = 3000
/** 给「之前有 N 条没发出」的说明留出位置。 */
const PACK_LIMIT = MAX_MESSAGE_CHARS - 40

export class Notifier {
  private queue: string[] = []
  private timer: NodeJS.Timeout | null = null
  private sentAt: number[] = []
  private dropped = 0
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

  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const items = this.queue.splice(0)
    if (!items.length) return
    const groupId = this.getAdminGroup()
    if (!groupId) return
    for (const message of pack(items)) {
      await this.sendOne(groupId, message)
    }
  }

  private async sendOne(groupId: string, text: string) {
    const now = this.now()
    this.sentAt = this.sentAt.filter((t) => now - t < 3600_000)
    if (this.sentAt.length >= MAX_MESSAGES_PER_HOUR) {
      this.dropped++
      this.logger.warn('运维通知超过每小时 %d 条的上限，这条只写日志', MAX_MESSAGES_PER_HOUR)
      return
    }
    if (this.dropped) {
      text = `（之前有 ${this.dropped} 条通知因为限速没有发出，请看 Koishi 日志）\n${text}`
      this.dropped = 0
    }
    const { bot, problem } = this.platform.pickBot()
    if (!bot) {
      this.logger.warn('运维通知没有发出：%s', problem)
      return
    }
    try {
      this.sentAt.push(now)
      this.history.push(text)
      if (this.history.length > 50) this.history.shift()
      await this.platform.sendGroup(bot, groupId, h.text(text))
    } catch (error) {
      if (isOneBotTimeout(error)) this.logger.warn('运维通知可能已经送达（LLBot 响应超时），不会重发')
      else this.logger.warn('运维通知发送失败：%s', error)
    }
  }
}

/**
 * 把几条通知拼成若干条不超过上限的消息。
 * 短通知合并成一条（不加序号）；一份太长的通知单独切成几条，序号按这一份计（1/3、2/3、3/3）。
 */
export function pack(items: string[], limit = PACK_LIMIT): string[] {
  const messages: string[] = []
  let current = ''
  const flush = () => {
    if (current) messages.push(current)
    current = ''
  }
  for (const item of items) {
    const parts = splitMessage(item, limit)
    if (parts.length > 1) {
      flush()
      messages.push(...parts)
      continue
    }
    const piece = parts[0]
    if (current && charLength(current) + 2 + charLength(piece) > limit) flush()
    current = current ? `${current}\n\n${piece}` : piece
  }
  flush()
  return messages
}

/** 运维群号：规范化后返回；没填返回 null。 */
export function resolveAdminGroup(value: string): string | null {
  return normalizeId(value)
}
