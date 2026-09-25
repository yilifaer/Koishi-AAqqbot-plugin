// 请求签名，算法见 aa-qqbot 仓库 API.md 第 2 节。

import { createHash, createHmac, randomBytes } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 五段用单个 `\n` 连接、末尾没有换行的待签名字符串。 */
export function signingString(path: string, timestamp: string, nonce: string, bodyText: string): string {
  return ['POST', path, timestamp, nonce, sha256Hex(bodyText)].join('\n')
}

export function sign(secret: string, path: string, timestamp: string, nonce: string, bodyText: string): string {
  return createHmac('sha256', secret).update(signingString(path, timestamp, nonce, bodyText), 'utf8').digest('hex')
}

/** 32 个十六进制字符，符合 API 要求的 16–64 位 `[A-Za-z0-9_-]`。 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex')
}

/** 当前 Unix 时间，单位秒。 */
export function unixSeconds(now = Date.now()): string {
  return Math.floor(now / 1000).toString()
}

export interface SignedHeaders {
  'Content-Type': string
  'X-QQBot-Key': string
  'X-QQBot-Timestamp': string
  'X-QQBot-Nonce': string
  'X-QQBot-Signature': string
}

export function signedHeaders(keyId: string, secret: string, path: string, bodyText: string, now = Date.now()): SignedHeaders {
  const timestamp = unixSeconds(now)
  const nonce = makeNonce()
  return {
    'Content-Type': 'application/json',
    'X-QQBot-Key': keyId,
    'X-QQBot-Timestamp': timestamp,
    'X-QQBot-Nonce': nonce,
    'X-QQBot-Signature': sign(secret, path, timestamp, nonce, bodyText),
  }
}
