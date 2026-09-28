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
  /** 最后发出（或放弃）的条数。 */
  pieces: number
  delivered: number
  timedOut: number
  hidden: number
  /** 没发出去的条数（拒收后没法再拆、超过上限、其他失败、暂停了）。 */
  lost: number
}

export interface SplitOptions<T> {
  /** 这条消息原来的序号，例如 3/4；拆出来的是 3/4-1、3/4-2。空字符串表示没有序号（拆出来按 1/1-1）。 */
  label?: string
  /** 只剩 1 个单元还被拒收时，换一种写法（隐藏名字）；返回 null 表示没法隐藏。 */
  hide?: (item: T) => T | null
}

/**
 * 发一条由 items 组成的消息；被拒收就对半拆开分别重发，直到送达或只剩 1 个单元。
 * send(part, label) 负责真正发出一条（包括序号、限速、发之前的检查和发成功后的记录）。
 */
export async function sendSplitting<T>(items: T[], send: (part: T[], label: string) => Promise<SendResult>, options: SplitOptions<T> = {}): Promise<SplitReport> {
  const report: SplitReport = { split: false, pieces: 0, delivered: 0, timedOut: 0, hidden: 0, lost: 0 }
  const tally = (result: SendResult, hidden = false) => {
    report.pieces++
    if (result === 'sent') {
      report.delivered++
      if (hidden) report.hidden++
    } else if (result === 'timeout') report.timedOut++
    else report.lost++
  }
  const attempt = async (part: T[], label: string): Promise<void> => {
    const result = await send(part, label)
    if (result !== 'refused') return tally(result)
    report.split = true
    if (part.length > 1) {
      const mid = Math.ceil(part.length / 2)
      const base = label || '1/1'
      await attempt(part.slice(0, mid), `${base}-1`)
      await attempt(part.slice(mid), `${base}-2`)
      return
    }
    const hidden = part.length && options.hide ? options.hide(part[0]) : null
    if (hidden === null) return tally('refused')
    const again = await send([hidden], label)
    tally(again === 'refused' ? 'failed' : again, true)
  }
  await attempt(items, options.label ?? '')
  return report
}

/** 拆开重发的结果，写日志用。 */
export function describeSplit(report: SplitReport): string {
  const outcome = report.lost || report.timedOut
    ? [
      `没有全部送达：${report.delivered} 条送达`,
      report.timedOut ? `，${report.timedOut} 条 LLBot 响应超时（可能已经送达）` : '',
      report.lost ? `，${report.lost} 条没发出（内容见前面的日志）` : '',
    ].join('')
    : '全部送达'
  return `被 QQ 拒收，拆成 ${report.pieces} 条重发，${outcome}${report.hidden ? `；其中 ${report.hidden} 条隐藏了名字` : ''}`
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

/**
 * 单独一行被 QQ 拒收时用：把「名字(QQ号)」里的名字（以及箭头后面要改成的名片）换成 HIDDEN_NAME，只留 QQ 号。
 * 开头的「· 」「⚡ 」这样的符号保留。这一行没有 QQ 号就返回 null（没有名字可以隐藏）。
 */
export function hideNames(line: string): string | null {
  const blank = /^\n*/.exec(line)![0]
  const text = line.slice(blank.length)
  const matches = [...text.matchAll(/\((\d{5,12})\)/g)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const head = /^[^\p{L}\p{N}\s]{1,3}\s/u.exec(text)?.[0] ?? ''
  const tail = text.slice(last.index! + last[0].length).replace(/ → .*$/, ` → ${HIDDEN_NAME}`)
  return `${blank}${head}${HIDDEN_NAME}${matches.map((m) => `(${m[1]})`).join('')}${tail}`
}
