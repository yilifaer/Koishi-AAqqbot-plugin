// 对 OneBot（LLBot）接口的薄封装。只用 adapter-onebot 6.9.4 里确实存在的方法（见交接文档 03 平台调研）。

import { Bot, Context, Fragment, Universal } from 'koishi'
import type { Member, Role } from './policy'
import { normalizeId } from './util'

export interface PendingJoinRequest {
  flag: string
  groupId: string
  qq: string
  comment: string
  invitorId: string | null
}

export class Platform {
  constructor(private ctx: Context, private getBotId: () => string) {}

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

  async listMembers(bot: Bot, groupId: string): Promise<Member[]> {
    const list = await bot.internal.getGroupMemberList(groupId)
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

  async sendGroup(bot: Bot, groupId: string, content: Fragment) {
    await bot.sendMessage(groupId, content)
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
  const role: Role = item.role === 'owner' || item.role === 'admin' ? item.role : 'member'
  return {
    qq,
    role,
    card: typeof item.card === 'string' ? item.card : '',
    nickname: typeof item.nickname === 'string' ? item.nickname : '',
    isRobot: item.is_robot === true,
  }
}
