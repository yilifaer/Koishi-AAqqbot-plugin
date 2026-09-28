// 发到运维群的通知：短时间内的多条合并成一条、全局限速、发送失败只记日志（交接文档 R18）。
// 所有内容都按纯文本发送（h.text），名片、群名、错误信息里的 <at> 之类不会被当成消息元素。
//
// 发送失败都不自动重发（运维通知、群里的提醒和公告都一样，DECISIONS 第 41 条）：
// LLBot 响应超时的那一条其实可能已经送达，重发会刷屏。
// 每条消息不超过 1500 字；一份通知太长时在空行 / 换行处分成几条，每条开头带（1/N）序号（DECISIONS 第 43 条）。
// 带名单（「名字(QQ号)」）的消息每条最多 20 行名单、约 800 字；被 QQ 拒收时对半拆开重发，
// 单独一行还被拒才把名字隐藏（DECISIONS 第 62 条）。超时的照旧不重发。

import { h, Logger } from 'koishi'
import type { Platform } from './platform'
import {
  charLength, countListLines, fitsLimits, isOneBotRefusal, isOneBotTimeout, ListLimits, MAX_LIST_CHARS, MAX_LIST_LINES,
  MAX_MESSAGE_CHARS, normalizeId, splitMessage,
} from './util'

const MAX_MESSAGES_PER_HOUR = 30
const FLUSH_DELAY_MS = 3000
/** 给「之前有 N 条没发出」的说明留出位置。 */
const PACK_LIMIT = MAX_MESSAGE_CHARS - 40
const LIST_LIMITS: ListLimits = { lines: MAX_LIST_LINES, chars: MAX_LIST_CHARS - 40 }
/** 单独一行仍被 QQ 拒收时，名字换成这句话再发一次。 */
export const HIDDEN_NAME = '（名字含 QQ 不允许的内容，已隐藏）'
/** 消息开头的序号，例如（3/4）、（3/4-2）。 */
const LABEL = /^（(\d+\/\d+(?:-\d+)*)）/

type SendResult = 'sent' | 'timeout' | 'refused' | 'failed' | 'capped'

/** 一条消息被拒收后拆开重发的统计，写进日志。 */
interface ResendReport {
  pieces: number
  delivered: number
  timedOut: number
  hidden: number
  lost: number
}

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
      await this.deliver(groupId, message)
    }
  }

  /** 发一条消息；被 QQ 拒收时对半拆开重发（DECISIONS 第 62 条）。 */
  private async deliver(groupId: string, text: string) {
    if ((await this.sendOne(groupId, text)) !== 'refused') return
    const match = LABEL.exec(text)
    const label = match ? match[1] : '1/1'
    const lines = (match ? text.slice(match[0].length) : text).split('\n')
    const report: ResendReport = { pieces: 0, delivered: 0, timedOut: 0, hidden: 0, lost: 0 }
    await this.resend(groupId, label, lines, report)
    const which = match ? `（${label}）` : `「${Array.from(lines.find((line) => line.trim()) ?? '').slice(0, 20).join('')}…」`
    const outcome = report.lost || report.timedOut
      ? [
        '没有全部送达：',
        `${report.delivered} 条送达`,
        report.timedOut ? `，${report.timedOut} 条 LLBot 响应超时（可能已经送达）` : '',
        report.lost ? `，${report.lost} 条没发出（内容见前面的日志）` : '',
      ].join('')
      : '全部送达'
    const hidden = report.hidden ? `；其中 ${report.hidden} 行的名字已隐藏` : ''
    this.logger.warn('运维通知%s被 QQ 拒收，拆成 %d 条重发，%s%s', which, report.pieces, outcome, hidden)
  }

  /** 被拒收的这一段对半拆开分别重发，还被拒就接着拆；只剩 1 行还被拒，把名字隐藏后再发一次。 */
  private async resend(groupId: string, label: string, lines: string[], report: ResendReport) {
    const body = trimBlankLines(lines)
    const content = body.filter((line) => line.trim())
    if (content.length <= 1) {
      const hidden = content.length ? hideNames(content[0]) : null
      if (hidden === null) {
        report.lost++
        this.logger.warn('运维通知（%s）这一行被 QQ 拒收，里面没有名字可以隐藏，只写日志：%s', label, content[0] ?? '')
        return
      }
      report.pieces++
      const result = await this.sendOne(groupId, `（${label}）${hidden}`)
      if (result === 'sent') {
        report.delivered++
        report.hidden++
        this.logger.warn('运维通知（%s）这一行被 QQ 拒收，隐藏名字后发出：%s', label, content[0])
      } else if (result === 'timeout') {
        report.timedOut++
      } else {
        report.lost++
        this.logger.warn('运维通知（%s）这一行隐藏名字后还是没发出，只写日志：%s', label, content[0])
      }
      return
    }
    // 按有内容的行数对半分
    let seen = 0
    const half = Math.ceil(content.length / 2)
    const cut = body.findIndex((line) => line.trim() && ++seen > half)
    const halves = [body.slice(0, cut), body.slice(cut)]
    for (const [index, part] of halves.entries()) {
      const sub = `${label}-${index + 1}`
      report.pieces++
      const result = await this.sendOne(groupId, `（${sub}）${trimBlankLines(part).join('\n')}`)
      if (result === 'sent') report.delivered++
      else if (result === 'timeout') report.timedOut++
      else if (result === 'refused') {
        report.pieces--
        await this.resend(groupId, sub, part, report)
      } else report.lost++
    }
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
    const dropped = this.dropped
    if (dropped) text = `（之前有 ${dropped} 条通知因为限速没有发出，请看 Koishi 日志）\n${text}`
    const { bot, problem } = this.platform.pickBot()
    if (!bot) {
      this.logger.warn('运维通知没有发出：%s', problem)
      return 'failed'
    }
    this.sentAt.push(now)
    this.history.push(text)
    if (this.history.length > 50) this.history.shift()
    try {
      await this.platform.sendGroup(bot, groupId, h.text(text))
      this.dropped -= dropped
      return 'sent'
    } catch (error) {
      if (isOneBotTimeout(error)) {
        this.dropped -= dropped
        this.logger.warn('运维通知可能已经送达（LLBot 响应超时），不会重发')
        return 'timeout'
      }
      // 没发出去：「之前有 N 条没发出」的说明留给下一条
      this.logger.warn('运维通知发送失败：%s', error)
      return isOneBotRefusal(error) ? 'refused' : 'failed'
    }
  }
}

/** 去掉开头和结尾的空行。 */
function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

/**
 * 单独一行被 QQ 拒收时用：把「名字(QQ号)」里的名字（以及箭头后面要改成的名片）换成 HIDDEN_NAME，只留 QQ 号。
 * 开头的「· 」「⚡ 」这样的符号保留。这一行没有 QQ 号就返回 null（没有名字可以隐藏）。
 */
export function hideNames(line: string): string | null {
  const matches = [...line.matchAll(/\((\d{5,12})\)/g)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const head = /^[^\p{L}\p{N}\s]{1,3}\s/u.exec(line)?.[0] ?? ''
  const tail = line.slice(last.index! + last[0].length).replace(/ → .*$/, ` → ${HIDDEN_NAME}`)
  return `${head}${HIDDEN_NAME}${matches.map((m) => `(${m[1]})`).join('')}${tail}`
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
