// 与业务无关的小工具：号码规范化、名片截断、时间计算、可中断的等待。

/** 全角数字、字母转半角，去掉首尾空白。 */
export function toHalfWidth(value: string): string {
  return value.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim()
}

const QQ_PATTERN = /^[1-9]\d{4,10}$/

/**
 * 把 QQ 号或群号统一成 5–11 位的 ASCII 数字字符串；不合法时返回 null。
 * 接受数字（配置文件里没加引号）、全角数字和首尾空白。
 */
export function normalizeId(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    value = String(value)
  }
  if (typeof value !== 'string') return null
  const text = toHalfWidth(value)
  return QQ_PATTERN.test(text) ? text : null
}

/** 规范化一组号码，丢掉不合法的，去重。 */
export function normalizeIdList(values: readonly unknown[] | undefined): string[] {
  const result = new Set<string>()
  for (const value of values ?? []) {
    const id = normalizeId(value)
    if (id) result.add(id)
  }
  return [...result]
}

/** 把号码打码成 `12****78`，用于日志。 */
export function maskId(id: string): string {
  if (id.length <= 4) return '****'
  return `${id.slice(0, 2)}****${id.slice(-2)}`
}

/** 按 UTF-8 字节数截断，不会切断多字节字符（包括 emoji）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    result += char
  }
  return result
}

/** 解析 `HH:mm`，不合法时返回 null。 */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(toHalfWidth(text))
  if (!match) return null
  const hour = +match[1]
  const minute = +match[2]
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 从 `now` 起下一次到达本地时间 `hour:minute` 的时刻（毫秒时间戳）。 */
export function nextClockTime(now: number, hour: number, minute: number): number {
  const date = new Date(now)
  date.setHours(hour, minute, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** `9月27日 19:30` 这样的本地时间。 */
export function formatDeadline(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `09-25 14:00` 这样的本地时间。 */
export function formatShortTime(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 按占位符 `{name}` 填充模板；没有提供的占位符原样保留。 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole))
}

export class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortedError'
  }
}

/** 等待 `ms` 毫秒；`signal` 中止时立即以 AbortedError 结束。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortedError()
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ---------------------------------------------------------------- 名字显示（K7 / K8）

// 必须用 \u 转义写，不要直接粘贴看不见的字符（复制时容易丢，审查也看不出来）
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u3164\u115F\u1160\uFFA0\u180E\u034F]/g

/** 去掉零宽字符、韩文填充符等看不见的字符，再去掉首尾空白（包括全角空格）。名字中间的空格保留。 */
export function cleanName(text: string): string {
  return (text ?? '').replace(INVISIBLE, '').trim()
}

/** 报告里显示的名字：名片（去掉标记）→ 昵称 → 空字符串。 */
export function displayName(card: string, nickname: string, markPrefix: string): string {
  for (const raw of [card, nickname]) {
    const cleaned = cleanName(raw)
    const name = markPrefix && cleaned.startsWith(markPrefix) ? cleanName(cleaned.slice(markPrefix.length)) : cleaned
    if (name) return name
  }
  return ''
}

// ---------------------------------------------------------------- OneBot 错误（K9）

export const ONEBOT_TIMEOUT_HINT = 'LLBot 响应超时，检查 adapter-onebot 的 responseTimeout（建议 60000 毫秒）'

/** adapter-onebot 的 TimeoutError：LLBot 没在 responseTimeout 内回应（其实可能已经成功了）。 */
export function isOneBotTimeout(error: unknown): boolean {
  return error instanceof Error && (error.constructor?.name === 'TimeoutError' || /^Timeout with request/.test(error.message))
}

/** adapter-onebot 的 SenderError：LLBot 明确返回了失败（retcode 不为 0）。 */
export function isOneBotRefusal(error: unknown): boolean {
  return error instanceof Error && !isOneBotTimeout(error)
    && (error.constructor?.name === 'SenderError' || /^Error with request/.test(error.message))
}

// ---------------------------------------------------------------- 消息分段（K13）

/** QQ 单条消息按不超过这么多字发。 */
export const MAX_MESSAGE_CHARS = 1500

/** 按字符（不是 UTF-16 码元）计数，emoji 算 1 个。 */
export function charLength(text: string): number {
  return Array.from(text).length
}

/**
 * 把一段文字切成每条不超过 max 字的若干条：优先在空行（小节边界）切，其次在换行切；
 * 单独一行还是太长才硬切（结尾加「…」），不会切断汉字或 emoji。切成多条时每条开头加（i/N）。
 */
export function splitMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (charLength(text) <= max) return [text]
  const parts = splitInto(text, max - 12) // 给（i/N）序号留位置
  if (parts.length <= 1) return parts
  return parts.map((part, index) => `（${index + 1}/${parts.length}）${part}`)
}

function splitInto(text: string, limit: number): string[] {
  // 先拆成「单元」：小节（空行分隔）→ 太长的小节再拆成行 → 太长的行再硬切
  const units: Array<{ text: string; sep: string }> = []
  text.split(/\n{2,}/).forEach((block, blockIndex) => {
    const blockSep = blockIndex === 0 ? '' : '\n\n'
    if (charLength(block) <= limit) {
      units.push({ text: block, sep: blockSep })
      return
    }
    block.split('\n').forEach((line, lineIndex) => {
      const lineSep = lineIndex === 0 ? blockSep : '\n'
      if (charLength(line) <= limit) {
        units.push({ text: line, sep: lineSep })
        return
      }
      const chars = Array.from(line)
      for (let i = 0; i < chars.length; i += limit - 1) {
        const piece = chars.slice(i, i + limit - 1).join('')
        units.push({ text: i + limit - 1 < chars.length ? `${piece}…` : piece, sep: i === 0 ? lineSep : '' })
      }
    })
  })
  // 再按顺序装进一条条消息
  const parts: string[] = []
  let current = ''
  for (const unit of units) {
    if (!current) {
      current = unit.text
    } else if (charLength(current) + charLength(unit.sep) + charLength(unit.text) <= limit) {
      current += unit.sep + unit.text
    } else {
      parts.push(current)
      current = unit.text
    }
  }
  if (current) parts.push(current)
  return parts
}
