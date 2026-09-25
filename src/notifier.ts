// 发到运维群的通知：短时间内的多条合并成一条、全局限速、发送失败只记日志（交接文档 R18）。
// 所有内容都按纯文本发送（h.text），名片、群名、错误信息里的 <at> 之类不会被当成消息元素。

import { h, Logger } from 'koishi'
import type { Platform } from './platform'
import { normalizeId } from './util'

const MAX_MESSAGE_CHARS = 1500
const MAX_MESSAGES_PER_HOUR = 30
const FLUSH_DELAY_MS = 3000

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
    this.logger.info(text.replace(/\n/g, ' | '))
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
      await this.platform.sendGroup(bot, groupId, h.text(text))
    } catch (error) {
      this.logger.warn('运维通知发送失败：%s', error)
    }
  }
}

/** 按行把多条通知拼成若干条不超过上限的消息。 */
export function pack(items: string[]): string[] {
  const messages: string[] = []
  let current = ''
  for (const item of items) {
    for (const piece of splitLong(item)) {
      if (current && current.length + 2 + piece.length > MAX_MESSAGE_CHARS) {
        messages.push(current)
        current = ''
      }
      current = current ? `${current}\n\n${piece}` : piece
    }
  }
  if (current) messages.push(current)
  return messages
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text]
  const pieces: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const safeLine = line.length > MAX_MESSAGE_CHARS ? line.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : line
    if (current && current.length + 1 + safeLine.length > MAX_MESSAGE_CHARS) {
      pieces.push(current)
      current = ''
    }
    current = current ? `${current}\n${safeLine}` : safeLine
  }
  if (current) pieces.push(current)
  return pieces
}

/** 运维群号：规范化后返回；没填返回 null。 */
export function resolveAdminGroup(value: string): string | null {
  return normalizeId(value)
}
