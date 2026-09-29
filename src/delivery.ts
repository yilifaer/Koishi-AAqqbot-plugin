// 发消息被 QQ 拒收时拆小重发（DECISIONS 第 62 条）。
//
// QQ 的内容审核按整条消息判断：一长串「名字 + QQ 号」凑在一起会被当成广告拒收（retcode 1200），拆成小段就能发出去。
// 所以机器人发的所有消息（运维通知、命令回复、群里的提醒和移出公告）被拒收时，都对半拆开分别重发，还被拒就接着拆，
// 直到送达或只剩 1 个单元（一行、一个名字、一个被 @ 的人）；只剩 1 个还被拒，能隐藏名字的隐藏后再发一次。
// LLBot 响应超时不算拒收：那一条其实可能已经送达，照旧不重发（DECISIONS 第 41 条）。

import { isOneBotRefusal, isOneBotTimeout } from './util'

/**
 * 发一条消息的结果：sent 送达；timeout LLBot 响应超时（可能已经送达，不重发）；refused QQ 拒收（会拆开重发）；
 * failed 其他失败（不重发）；capped 超过每小时上限，只写日志；skipped 发之前发现已经暂停或不能再发了。
 */
export type SendResult = 'sent' | 'timeout' | 'refused' | 'failed' | 'capped' | 'skipped'

/** 发送时的错误属于哪一类。 */
export function classifySendError(error: unknown): 'timeout' | 'refused' | 'failed' {
  if (isOneBotTimeout(error)) return 'timeout'
  return isOneBotRefusal(error) ? 'refused' : 'failed'
}

/** 单独一行仍被 QQ 拒收时，名字换成这句话再发一次。 */
export const HIDDEN_NAME = '（名字含 QQ 不允许的内容，已隐藏）'

/** 一条消息被拒收后拆开重发的统计，写进日志。 */
export interface SplitReport {
  /** 有没有被拒收过（没有的话下面只有一条）。 */
  split: boolean
  /** 有没有真的对半拆开过（只有 1 个单元的消息被拒时没法拆）。 */
  halved: boolean
  /** 最后发出（或放弃）的条数。 */
  pieces: number
  delivered: number
  timedOut: number
  hidden: number
  /** 没发出去的条数（拒收后没法再拆、超过上限、其他失败）。 */
  lost: number
  /** 轮到时已经暂停或不能再发、没有发的条数。 */
  skipped: number
}

export interface SplitOptions<T> {
  /** 这条消息原来的序号，例如 3/4；拆出来的是 3/4-1、3/4-2。空字符串表示没有序号（拆出来按 1/1-1）。 */
  label?: string
  /** 只剩 1 个单元还被拒收时，换一种写法（隐藏名字）；返回 null 表示没法隐藏。 */
  hide?: (item: T) => T | null
  /**
   * 放弃了的一段（写日志用）：why 是 capped / failed / skipped，或者 refused（被拒收，又没法再拆、没法隐藏或隐藏后还被拒）。
   * part 是原来的内容（不是隐藏后的）。
   */
  onLost?: (part: T[], label: string, why: SendResult) => void
  /** 隐藏了名字的那一行发出去了（result 是 sent 或 timeout）。 */
  onHidden?: (item: T, label: string, result: SendResult) => void
}

/**
 * 发一条由 items 组成的消息；被拒收就对半拆开分别重发，直到送达或只剩 1 个单元。
 * send(part, label) 负责真正发出一条（包括序号、限速、发之前的检查和发成功后的记录）。
 */
export async function sendSplitting<T>(items: T[], send: (part: T[], label: string) => Promise<SendResult>, options: SplitOptions<T> = {}): Promise<SplitReport> {
  const report: SplitReport = { split: false, halved: false, pieces: 0, delivered: 0, timedOut: 0, hidden: 0, lost: 0, skipped: 0 }
  const tally = (part: T[], label: string, result: SendResult, hidden = false) => {
    report.pieces++
    if (result === 'sent') {
      report.delivered++
      if (hidden) report.hidden++
    } else if (result === 'timeout') {
      report.timedOut++
    } else {
      if (result === 'skipped') report.skipped++
      else report.lost++
      options.onLost?.(part, label, result)
    }
  }
  const attempt = async (part: T[], label: string): Promise<void> => {
    const result = await send(part, label)
    if (result !== 'refused') return tally(part, label, result)
    report.split = true
    if (part.length > 1) {
      report.halved = true
      const mid = Math.ceil(part.length / 2)
      const base = label || '1/1'
      await attempt(part.slice(0, mid), `${base}-1`)
      await attempt(part.slice(mid), `${base}-2`)
      return
    }
    const hidden = part.length && options.hide ? options.hide(part[0]) : null
    if (hidden === null) return tally(part, label, 'refused')
    // 隐藏名字后只再发这一次：还被拒就只写日志
    const again = await send([hidden], label)
    if (again === 'sent' || again === 'timeout') options.onHidden?.(part[0], label, again)
    tally(part, label, again, true)
  }
  await attempt(items, options.label ?? '')
  return report
}

/** 拆开重发的结果，写日志用。 */
export function describeSplit(report: SplitReport, hiddenText = (n: number) => `其中 ${n} 条隐藏了名字`): string {
  const how = report.halved ? `拆成 ${report.pieces} 条重发` : '只有 1 行，没法拆开'
  const outcome = report.lost || report.timedOut || report.skipped
    ? [
      `没有全部送达：${report.delivered} 条送达`,
      report.timedOut ? `，${report.timedOut} 条 LLBot 响应超时（可能已经送达）` : '',
      report.lost ? `，${report.lost} 条没发出（内容见前面的日志）` : '',
      report.skipped ? `，${report.skipped} 条轮到时已经暂停或不能再发，没有发` : '',
    ].join('')
    : '全部送达'
  return `被 QQ 拒收，${how}，${outcome}${report.hidden ? `；${hiddenText(report.hidden)}` : ''}`
}

// ---------------------------------------------------------------- 按行拆的文字消息（运维通知、命令回复）

/** 消息开头的序号，例如（3/4）、（3/4-2）。 */
const LABEL = /^（(\d+\/\d+(?:-\d+)*)）/

/** 把一条文字消息分成序号和各行。空行并到下一行前面（「\n名字」），拆开后小节之间的空行还在。 */
export function textLines(text: string): { label: string; lines: string[] } {
  const match = LABEL.exec(text)
  const body = match ? text.slice(match[0].length) : text
  const lines: string[] = []
  let blank = ''
  for (const line of body.split('\n')) {
    if (!line.trim()) {
      if (lines.length) blank += '\n'
      continue
    }
    lines.push(blank + line)
    blank = ''
  }
  return { label: match ? match[1] : '', lines }
}

/** textLines 的反过程：序号 + 各行。 */
export function renderLines(lines: string[], label: string): string {
  const body = lines.map((line, index) => (index === 0 ? line.replace(/^\n+/, '') : line)).join('\n')
  return label ? `（${label}）${body}` : body
}

/** 「名字(QQ号)」里的 QQ 号部分。 */
const QQ_IN_PARENS = /\((\d{5,12})\)/g
/** 行首的「⚡ 群名（群号） 」「👋 群名（群号） 新成员 」：隐藏名字时保留。 */
const LINE_HEAD = /^[^\p{L}\p{N}\s]{1,3}\s(?:[^\n]*?（\d{5,12}）\s(?:新成员\s)?)?/u

/**
 * 单独一行被 QQ 拒收时用：把每个「名字(QQ号)」里的名字（以及箭头后面要改成的名片）换成 HIDDEN_NAME，只留 QQ 号。
 * 行首的符号、群名、说明文字都保留（名字从这一行的开头、「：」「、」或上一个 QQ 号后面算起）。
 * 这一行没有 QQ 号就返回 null（没有名字可以隐藏）。
 */
export function hideNames(line: string): string | null {
  const blank = /^\n*/.exec(line)![0]
  const text = line.slice(blank.length)
  if (!text.match(QQ_IN_PARENS)) return null
  const head = LINE_HEAD.exec(text)?.[0] ?? ''
  const body = text.slice(head.length)
  let out = ''
  let pos = 0
  for (const match of body.matchAll(QQ_IN_PARENS)) {
    const before = body.slice(pos, match.index)
    const cut = Math.max(before.lastIndexOf('：'), before.lastIndexOf('、'))
    out += `${before.slice(0, cut + 1)}${HIDDEN_NAME}${match[0]}`
    pos = match.index! + match[0].length
  }
  out += body.slice(pos).replace(/ → .*$/, ` → ${HIDDEN_NAME}`)
  return `${blank}${head}${out}`
}
