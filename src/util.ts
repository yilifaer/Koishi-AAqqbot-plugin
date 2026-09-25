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
