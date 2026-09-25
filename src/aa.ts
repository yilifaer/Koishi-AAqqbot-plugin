// 调用 AA（aa-qqbot）的机器人接口。接口契约见 aa-qqbot 仓库 API.md。
//
// 核心原则（API.md 1.1）：只有「HTTP 200 + JSON + ok === true + 字段结构正确」才算拿到了答案；
// 其余一切（网络错误、超时、重定向、网页、4xx/5xx、结构不对）都是「无法判断」，调用方绝不能据此处置任何人。

import type { Context } from 'koishi'
import { signedHeaders } from './signing'
import { errorHint } from './texts'
import { AbortedError, normalizeId, sleep } from './util'

export type Decision = 'allow' | 'deny' | 'review' | 'unknown'

export interface Verdict {
  qq: string
  decision: Decision
  reason: string
  card: string | null
}

export interface ManagedGroup {
  groupId: string
  name: string
  kind: string
}

export interface AaEvent {
  id: number
  kind: string
  qq: string
}

export interface ApiFailure {
  ok: false
  /** network：连不上；timeout：超时；http：非 200；invalid：200 但内容不对；aborted：插件停用或暂停。 */
  kind: 'network' | 'timeout' | 'http' | 'invalid' | 'aborted'
  status?: number
  error?: string
  message?: string
  retryable: boolean
  /** 给运维看的中文说明。 */
  hint: string
}

export type ApiResult<T> = ({ ok: true; serverTime?: string } & T) | ApiFailure

export interface CallOptions {
  signal?: AbortSignal
  /** 网络错误、超时、5xx 时的重试等待（毫秒），长度就是重试次数。 */
  retryDelays?: number[]
}

const DEFAULT_RETRY_DELAYS = [3_000, 15_000]
const MAX_RETRY_AFTER_MS = 120_000

export interface AaClientOptions {
  baseUrl: string
  keyId: string
  secret: string
  timeoutMs: number
  now?: () => number
}

export class AaClient {
  /** 最近一次成功响应里 AA 的时间与本机时间之差（毫秒，AA 减本机）。 */
  clockSkewMs: number | null = null

  constructor(private ctx: Context, private options: AaClientOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  endpoint(name: string): URL {
    const base = this.options.baseUrl.trim().replace(/\/+$/, '')
    return new URL(`${base}/qqbot/api/v1/${name}/`)
  }

  /** 调用一个接口，返回解析后的 JSON 对象或失败说明。 */
  async call(name: string, payload: object, options: CallOptions = {}): Promise<ApiResult<{ data: any }>> {
    let url: URL
    try {
      url = this.endpoint(name)
    } catch {
      return failure('invalid', { hint: 'AA 网址格式不对，请检查插件配置', retryable: false })
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return failure('invalid', { hint: 'AA 网址必须以 https:// 开头', retryable: false })
    }
    const bodyText = JSON.stringify(payload) // 只序列化一次，签名和发送用同一个字符串
    const delays = options.retryDelays ?? DEFAULT_RETRY_DELAYS
    let attempt = 0
    while (true) {
      const result = await this.once(url, bodyText, options.signal)
      if (result.ok || !result.retryable || attempt >= delays.length) return result
      let wait = delays[attempt++]
      if (result.status === 429 && (result as any).retryAfterMs) wait = (result as any).retryAfterMs
      try {
        await sleep(wait, options.signal)
      } catch {
        return failure('aborted', { hint: '已中止', retryable: false })
      }
    }
  }

  private async once(url: URL, bodyText: string, signal?: AbortSignal): Promise<ApiResult<{ data: any }>> {
    if (signal?.aborted) return failure('aborted', { hint: '已中止', retryable: false })
    // HTTP 插件会在传入的 signal 上挂监听器且不移除；每次请求用一个临时的 signal，用完解绑，避免长期累积
    const local = new AbortController()
    const forward = () => local.abort()
    signal?.addEventListener('abort', forward, { once: true })
    try {
      return await this.request(url, bodyText, local.signal, signal)
    } finally {
      signal?.removeEventListener('abort', forward)
    }
  }

  private async request(url: URL, bodyText: string, requestSignal: AbortSignal, signal?: AbortSignal): Promise<ApiResult<{ data: any }>> {
    // 每次请求（包括重试）都重新生成时间戳、随机数和签名
    const headers = signedHeaders(this.options.keyId, this.options.secret, url.pathname, bodyText, this.now())
    let response: { status: number; data: unknown; headers: Headers }
    try {
      response = await this.ctx.http(url.href, {
        method: 'POST',
        data: bodyText,
        headers: { ...headers },
        redirect: 'manual', // 绝不跟随重定向（API.md 1.1 第 3 条）
        validateStatus: () => true, // 状态码由下面自己判断
        responseType: 'text', // 自己解析 JSON，不让 HTTP 库按 Content-Type 猜
        timeout: this.options.timeoutMs,
        signal: requestSignal,
      }) as any
    } catch (error: any) {
      if (signal?.aborted || error instanceof AbortedError) return failure('aborted', { hint: '已中止', retryable: false })
      if (error?.code === 'ETIMEDOUT') {
        if (/disposed/.test(String(error?.message))) return failure('aborted', { hint: '插件已停用', retryable: false })
        return failure('timeout', { hint: `等待 AA 超过 ${Math.round(this.options.timeoutMs / 1000)} 秒没有回应`, retryable: true })
      }
      const cause = error?.cause?.cause?.code ?? error?.cause?.code ?? error?.cause?.message ?? error?.message
      return failure('network', { hint: `无法连接 AA（${String(cause ?? '网络错误')}）`, retryable: true })
    }

    const status = response.status
    let data: any = null
    if (typeof response.data === 'string') {
      try {
        data = JSON.parse(response.data)
      } catch {
        data = null
      }
    }
    if (status === 200) {
      if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === true) {
        this.noteServerTime(data.server_time)
        return { ok: true, data, serverTime: typeof data.server_time === 'string' ? data.server_time : undefined }
      }
      return failure('invalid', { status, hint: 'AA 返回了 200，但内容不是预期的 JSON（可能是网页或代理页面）', retryable: false })
    }

    const error = data && typeof data.error === 'string' ? data.error : undefined
    const message = data && typeof data.message === 'string' ? data.message : undefined
    const location = response.headers?.get?.('location')
    const result = failure('http', {
      status,
      error,
      message,
      hint: errorHint(error, status, location),
      // 只有 5xx 值得重试；AA 没配密钥（503 misconfigured）重试也没用
      retryable: status >= 500 && error !== 'misconfigured',
    })
    if (status === 429) {
      const seconds = Number(response.headers?.get?.('retry-after'))
      ;(result as any).retryAfterMs = Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000, MAX_RETRY_AFTER_MS)
      result.retryable = true
    }
    return result
  }

  private noteServerTime(value: unknown) {
    if (typeof value !== 'string') return
    const time = Date.parse(value)
    if (Number.isFinite(time)) this.clockSkewMs = time - this.now()
  }

  // ---------------------------------------------------------------- 各接口

  async health(options?: CallOptions): Promise<ApiResult<{ version: string; configOk: boolean; problems: string[] }>> {
    const result = await this.call('health', {}, options)
    if (!result.ok) return result
    const { data } = result
    return {
      ok: true,
      serverTime: result.serverTime,
      version: typeof data.version === 'string' ? data.version : '?',
      configOk: data.config_ok === true,
      problems: Array.isArray(data.problems) ? data.problems.filter((p: unknown) => typeof p === 'string') : [],
    }
  }

  async groups(options?: CallOptions): Promise<ApiResult<{ groups: ManagedGroup[] }>> {
    const result = await this.call('groups', {}, options)
    if (!result.ok) return result
    if (!Array.isArray(result.data.groups)) return invalid('groups 响应里没有 groups 列表')
    const groups: ManagedGroup[] = []
    for (const item of result.data.groups) {
      const groupId = normalizeId(item?.group_id)
      if (!groupId) continue
      groups.push({
        groupId,
        name: typeof item.name === 'string' ? item.name : groupId,
        kind: typeof item.kind === 'string' ? item.kind : 'fixed',
      })
    }
    return { ok: true, serverTime: result.serverTime, groups }
  }

  /**
   * 对一个群的一组 QQ 求判定。结果按请求顺序一一对应（API.md 5.3）；
   * 顺序对不上、QQ 回显不一致、判定值不认识的项，都当作 unknown。
   */
  async check(groupId: string, qqs: string[], fullRoster: boolean, options?: CallOptions): Promise<ApiResult<{ verdicts: Map<string, Verdict>; roster: unknown }>> {
    const result = await this.call('check', { group_id: groupId, qqs, full_roster: fullRoster }, options)
    if (!result.ok) return result
    const results = result.data.results
    if (!Array.isArray(results) || results.length !== qqs.length) {
      return invalid('check 响应的 results 数量和请求的不一致')
    }
    const verdicts = new Map<string, Verdict>()
    qqs.forEach((qq, index) => {
      verdicts.set(qq, parseVerdict(results[index], qq))
    })
    return { ok: true, serverTime: result.serverTime, verdicts, roster: result.data.roster }
  }

  /** 入群申请：申请人 QQ + 验证信息原文。只看 result.decision（API.md 5.4）。 */
  async claim(qq: string, text: string, groupId: string, options?: CallOptions): Promise<ApiResult<{ verdict: Verdict; outcome: string; message: string; claimed: boolean }>> {
    const result = await this.call('claim', { qq, text: text.slice(0, 2000), group_id: groupId }, options)
    if (!result.ok) return result
    const { data } = result
    if (!data.result || typeof data.result !== 'object') return invalid('claim 响应里没有 result')
    return {
      ok: true,
      serverTime: result.serverTime,
      verdict: parseVerdict(data.result, qq),
      outcome: typeof data.outcome === 'string' ? data.outcome : '',
      message: typeof data.message === 'string' ? data.message : '',
      claimed: data.claimed === true,
    }
  }

  async events(after: number, limit: number, options?: CallOptions): Promise<ApiResult<{ events: AaEvent[]; lastId: number; hasMore: boolean }>> {
    const result = await this.call('events', { after, limit }, options)
    if (!result.ok) return result
    const { data } = result
    if (!Array.isArray(data.events) || !Number.isSafeInteger(data.last_id) || data.last_id < after) {
      return invalid('events 响应格式不对')
    }
    const events: AaEvent[] = []
    for (const item of data.events) {
      if (!item || !Number.isSafeInteger(item.id) || typeof item.kind !== 'string') continue
      events.push({ id: item.id, kind: item.kind, qq: normalizeId(item.qq) ?? '' })
    }
    return { ok: true, serverTime: result.serverTime, events, lastId: data.last_id, hasMore: data.has_more === true }
  }
}

function parseVerdict(item: any, requestedQq: string): Verdict {
  const unknown: Verdict = { qq: requestedQq, decision: 'unknown', reason: 'UNKNOWN', card: null }
  if (!item || typeof item !== 'object') return unknown
  // AA 回显的 QQ 必须和请求的一致，否则不信任这一项
  if (normalizeId(item.qq) !== requestedQq) return unknown
  const reason = typeof item.reason === 'string' ? item.reason : 'UNKNOWN'
  const decision: Decision = item.decision === 'allow' || item.decision === 'deny' || item.decision === 'review'
    ? item.decision
    : 'unknown' // 不认识的 decision 一律当作「不处置」
  const card = decision === 'allow' && typeof item.card === 'string' && item.card.trim() ? item.card : null
  return { qq: requestedQq, decision, reason, card }
}

function failure(kind: ApiFailure['kind'], rest: Omit<ApiFailure, 'ok' | 'kind'>): ApiFailure {
  return { ok: false, kind, ...rest }
}

function invalid(hint: string): ApiFailure {
  return failure('invalid', { status: 200, hint: `AA 的响应格式不对：${hint}`, retryable: false })
}

/** 一行给运维看的失败说明。 */
export function describeFailure(result: ApiFailure): string {
  const parts = [result.hint]
  if (result.message && result.message !== result.hint) parts.push(`AA 说明：${result.message}`)
  return parts.join('；')
}
