// 对 OneBot（LLBot）接口的薄封装。只用 adapter-onebot 6.9.4 里确实存在的方法（见交接文档 03 平台调研）。

import { Bot, Context, Fragment, Session, Universal } from 'koishi'
import type { Member, Role } from './policy'
import { normalizeId, sleep } from './util'

/** 机器人发的任意两条消息之间至少隔这么久（DECISIONS 第 63 条）。 */
export const SEND_GAP_MS = 2000

export interface PendingJoinRequest {
  flag: string
  groupId: string
  qq: string
  comment: string
  invitorId: string | null
}

export class Platform {
  /** 上一条消息发完（成功、失败、超时都算）的时间。 */
  private lastSentAt = 0
  private sendQueue: Promise<unknown> = Promise.resolve()

  constructor(private ctx: Context, private getBotId: () => string, private sendGapMs = SEND_GAP_MS) {}

  /** 所有机器人账号（任何平台），永远不处置。 */
  allSelfIds(): Set<string> {
    return new Set(this.ctx.bots.map((bot) => bot.selfId).filter(Boolean))
  }

  /**
   * 选出负责管理的 OneBot 机器人。配置了 botId 时只用它；
   * 没配置时，只有恰好一个 OneBot 机器人才使用，避免多个机器人重复处置（交接文档 D37）。
   */
  pickBot(): { bot: Bot | null; problem: string | null } {
    const bots = this.ctx.bots.filter((bot) => bot.platform === 'onebot')
    const wanted = normalizeId(this.getBotId())
    let bot: Bot | undefined
    if (wanted) {
      bot = bots.find((b) => b.selfId === wanted)
      if (!bot) return { bot: null, problem: `找不到 QQ 号为 ${wanted} 的 OneBot 机器人` }
    } else if (bots.length === 1) {
      bot = bots[0]
    } else if (bots.length === 0) {
      return { bot: null, problem: '这个 Koishi 里没有 OneBot 机器人' }
    } else {
      return { bot: null, problem: '这个 Koishi 里有多个 OneBot 机器人，请在插件配置里填写「用哪个机器人账号管理」' }
    }
    if (bot.status !== Universal.Status.ONLINE) return { bot: null, problem: `机器人 ${bot.selfId} 当前不在线` }
    if (typeof (bot.internal as any)?._request !== 'function') return { bot: null, problem: `机器人 ${bot.selfId} 与 LLBot 的连接已断开` }
    return { bot, problem: null }
  }

  /**
   * 取群成员名单，强制 LLBot 从 QQ 服务器刷新（no_cache）。
   * adapter-onebot 的 getGroupMemberList 会丢掉 no_cache 参数（交接文档 03 #15），所以直接调用底层接口。
   */
  async listMembers(bot: Bot, groupId: string): Promise<Member[]> {
    const id = Number(groupId)
    const response = await (bot.internal as any)._request('get_group_member_list', {
      group_id: Math.abs(id) < 4294967296 ? id : groupId,
      no_cache: true,
    })
    if (!response || response.retcode !== 0) throw new Error(`取群成员名单失败（retcode ${response?.retcode}）`)
    const list = response.data
    if (!Array.isArray(list)) throw new Error('群成员列表格式不对')
    const members: Member[] = []
    for (const item of list) {
      const member = toMember(item)
      if (member) members.push(member)
    }
    return members
  }

  /** 实时查询一个成员（不走缓存）。查不到或出错时返回 null。 */
  async getMember(bot: Bot, groupId: string, qq: string): Promise<Member | null> {
    try {
      return toMember(await bot.internal.getGroupMemberInfo(groupId, qq, true))
    } catch {
      return null
    }
  }

  /** 移出，不拉黑（reject_add_request = false，DECISIONS 第 15 条）。 */
  async kick(bot: Bot, groupId: string, qq: string) {
    await bot.internal.setGroupKick(groupId, qq, false)
  }

  async setCard(bot: Bot, groupId: string, qq: string, card: string) {
    await bot.internal.setGroupCard(groupId, qq, card)
  }

  async handleJoinRequest(bot: Bot, flag: string, approve: boolean, reason = '') {
    await bot.handleGuildMemberRequest(flag, approve, reason)
  }

  /**
   * 排队发消息：一条一条地发，上一条发完后至少隔 sendGapMs 再发下一条（DECISIONS 第 63 条）。
   * ready 在真正发出之前调用（排队可能要等一会儿），返回 false 就不发了（例如这期间暂停了），结果是 false。
   */
  private paced(send: () => Promise<unknown>, ready?: () => boolean | Promise<boolean>): Promise<boolean> {
    const run = async () => {
      const wait = this.lastSentAt + this.sendGapMs - Date.now()
      if (wait > 0) await sleep(wait)
      if (ready && !(await ready())) return false
      try {
        await send()
        return true
      } finally {
        this.lastSentAt = Date.now()
      }
    }
    const result = this.sendQueue.then(run, run)
    this.sendQueue = result.catch(() => {})
    return result
  }

  /** 发到群里。返回 false 表示 ready 说不发了；发送失败时抛出错误（超时、拒收等）。 */
  sendGroup(bot: Bot, groupId: string, content: Fragment, ready?: () => boolean | Promise<boolean>): Promise<boolean> {
    return this.paced(() => bot.sendMessage(groupId, content), ready)
  }

  /**
   * 回复命令（私聊或运维群）。不用 session.send：它会吞掉错误，看不出是不是被 QQ 拒收了。
   */
  reply(session: Session, content: Fragment): Promise<boolean> {
    return this.paced(() => session.bot.sendMessage(session.channelId!, content, undefined, { session }))
  }

  /** 掉线期间积压的入群申请（LLBot 的 get_group_system_msg；字段名按 LLBot 实际返回解析）。 */
  async pendingJoinRequests(bot: Bot): Promise<PendingJoinRequest[]> {
    const data: any = await bot.internal.getGroupSystemMsg()
    const list = Array.isArray(data?.join_requests) ? data.join_requests : []
    const result: PendingJoinRequest[] = []
    for (const item of list) {
      if (!item || item.checked === true) continue
      const groupId = normalizeId(item.group_id)
      const qq = normalizeId(item.requester_uin)
      if (!groupId || !qq || item.request_id === undefined || item.request_id === null) continue
      result.push({
        flag: String(item.request_id),
        groupId,
        qq,
        comment: typeof item.message === 'string' ? item.message : '',
        invitorId: normalizeId(item.invitor_uin),
      })
    }
    return result
  }
}

function toMember(item: any): Member | null {
  const qq = normalizeId(item?.user_id)
  if (!qq) return null
  // 只有明确是 member 的才算普通成员；认不出来的按受保护处理（R7「角色判不出就跳过」）
  const role: Role = item.role === 'owner' || item.role === 'admin' || item.role === 'member' ? item.role : 'unknown'
  return {
    qq,
    role,
    card: typeof item.card === 'string' ? item.card : '',
    nickname: typeof item.nickname === 'string' ? item.nickname : '',
    isRobot: item.is_robot === true,
  }
}
