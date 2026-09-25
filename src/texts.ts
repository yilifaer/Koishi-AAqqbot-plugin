// 给人看的中文说明：判定原因、验证码结果、AA 接口错误。

/** 群里 @ 提醒、运维报告里用的简短原因。 */
const REASON_SHORT: Record<string, string> = {
  OK: '合格',
  NOT_BOUND: '没有在 AA 绑定 QQ',
  PENDING_VERIFY: '已在 AA 提交但还没验证',
  USER_INACTIVE: 'AA 账号已停用',
  NO_MAIN: 'AA 账号没有主角色',
  NO_ACCESS: 'AA 账号没有成员资格',
  GROUP_ROLE_MISSING: '不在本群要求的 AA 组里',
  CONFLICT: '同一个 QQ 被两个 AA 账号认领',
  GROUP_MISCONFIGURED: 'AA 上这个群的设置不完整',
  BAD_QQ: 'QQ 号格式不对',
}

export function reasonShort(reason: string): string {
  return REASON_SHORT[reason] ?? `不满足条件（${reason}）`
}

/** 拒绝入群申请时给申请人看的说明（按验证码结果优先，其次按判定原因）。 */
const OUTCOME_HINT: Record<string, string> = {
  code_invalid: '验证码不对，请核对 AA 上显示的验证码后重新申请',
  code_expired: '验证码已过期，请在 AA 上重新生成验证码后重新申请',
  code_used: '验证码已经用过，请在 AA 上重新生成验证码后重新申请',
  qq_mismatch: '这个验证码不是给这个 QQ 的，请确认 AA 上填写的 QQ 号正确，重新生成验证码后再申请',
}

const REASON_HINT: Record<string, string> = {
  NOT_BOUND: '请先登录联盟 AA 绑定 QQ，再把验证码填进入群申请的验证信息',
  PENDING_VERIFY: '请把 AA 上显示的验证码填进入群申请的验证信息',
  USER_INACTIVE: '你的 AA 账号已停用，请联系管理员',
  NO_MAIN: '请先在 AA 设置主角色',
  NO_ACCESS: '你的 AA 账号暂时没有成员资格，请联系管理员',
  GROUP_ROLE_MISSING: '你不在本群要求的 AA 组里，请联系管理员',
}

export function rejectHint(outcome: string | undefined, reason: string): string {
  if (outcome && OUTCOME_HINT[outcome]) return OUTCOME_HINT[outcome]
  return REASON_HINT[reason] ?? '你暂时不满足入群条件，请联系管理员'
}

export const MODE_TEXT: Record<string, string> = {
  off: 'off（不管）',
  report: 'report（只报告）',
  remind: 'remind（提醒，不踢）',
  enforce: 'enforce（提醒并移出）',
}

/** AA 错误码 → 怎么修（给运维看）。见 API.md 第 6 节。 */
const ERROR_HINT: Record<string, string> = {
  bad_request: '请求内容不对，多半是插件的问题，请把日志发给插件维护者',
  missing_headers: '签名请求头缺失或格式不对；检查插件配置里的「密钥编号」，不能有空格或中文',
  unknown_key: '密钥编号在 AA 上不存在；插件配置里的「密钥编号」要和 AA 的 QQBOT_API_KEYS 一致',
  stale_timestamp: '机器人电脑和 AA 服务器的时间相差太大；请打开机器人电脑的「自动设置时间」',
  bad_signature: '签名不对；检查插件配置里的密钥是否与 AA 上的完全一致（不能多空格）',
  replayed_nonce: '随机数重复（一般是网络重试造成的），会自动恢复',
  unknown_group: '这个群在 AA 上不存在或已停用，插件会重新获取群列表',
  method_not_allowed: '请求方法不对，请把日志发给插件维护者',
  too_large: '一次发送的内容太多',
  rate_limited: '请求太频繁，已被 AA 限速，稍后自动继续',
  internal_error: 'AA 内部出错，稍后自动重试；多次出现请联系 IT 查看 AA 日志',
  misconfigured: 'AA 没有配置机器人密钥；请联系 IT 在 local.py 配置 QQBOT_API_KEYS',
}

export function errorHint(error: string | undefined, status: number | undefined, location?: string | null): string {
  if (error && ERROR_HINT[error]) return ERROR_HINT[error]
  if (status === 302 || status === 303 || status === 307) {
    if (location && /login/i.test(location)) {
      return 'AA 把请求转到了登录页：AA 的 local.py 缺少 APPS_WITH_PUBLIC_VIEWS += ["qqbot"]，请联系 IT 追加后重启 AA'
    }
    return `AA 返回了重定向（HTTP ${status}）：检查插件配置里的 AA 网址（用 https://，末尾不要多写路径）`
  }
  if (status === 301 || status === 308) {
    return `AA 返回了永久重定向（HTTP ${status}）：AA 网址请用 https://`
  }
  if (status === 404) return 'AA 上找不到机器人接口（HTTP 404）：检查 AA 网址，或让 IT 确认 aa-qqbot 插件已安装'
  if (status === 403) return 'AA 前面的网关或防火墙拦截了请求（HTTP 403），请让 IT 放行'
  if (status === 413) return 'AA 前面的 nginx 拒绝了请求（HTTP 413），请让 IT 把 client_max_body_size 调大到至少 1 MB'
  if (status === 502 || status === 504) return `AA 正在重启或过载（HTTP ${status}），稍后自动重试`
  if (status && status >= 500) return `AA 服务器出错（HTTP ${status}），稍后自动重试`
  if (status) return `AA 返回了意外的结果（HTTP ${status}）`
  return '无法连接 AA'
}
