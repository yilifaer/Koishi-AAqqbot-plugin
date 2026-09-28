// 管理命令。必须同时满足三个条件才能用（DECISIONS 第 10 条、交接文档 R13）：
//   ① 在运维群里或私聊机器人；② QQ 在运维名单里；③ Koishi 权限等级 ≥ 3。
// 在其他任何群（包括受管群）里发命令，一律不回应。

import { Argv, Context, h, Session } from 'koishi'
import { classifySendError, describeSplit, hideNames, renderLines, sendSplitting, textLines } from './delivery'
import type { Guard } from './guard'
import { MAX_LIST_CHARS, MAX_LIST_LINES, MAX_MESSAGE_CHARS, normalizeId, splitMessage } from './util'

/** 一次命令回复最多发几条（DECISIONS 第 43 条）。 */
export const MAX_REPLY_PARTS = 5

export function registerCommands(ctx: Context, guard: Guard) {
  const gate = async ({ session }: Argv) => {
    if (!session || session.platform !== 'onebot') return ''
    const admin = guard.adminGroup()
    const inPrivate = session.isDirect
    const inAdminGroup = !session.isDirect && !!admin && normalizeId(session.guildId) === admin
    if (!inPrivate && !inAdminGroup) return '' // 不回应
    const qq = normalizeId(session.userId)
    if (!qq || !guard.operators().has(qq)) {
      await send(session, '你不在运维名单里，不能使用这个命令。')
      return ''
    }
    // 返回 undefined 表示继续，接下来由 Koishi 检查权限等级（authority: 3）
  }

  /**
   * 发出一条回复：和机器人发的其他消息一起排队、相互隔 2 秒（DECISIONS 第 63 条）；
   * 被 QQ 拒收时对半拆开重发，单独一行还被拒才隐藏名字（DECISIONS 第 62 条）。
   */
  const send = async (session: Session, text: string) => {
    const { label, lines } = textLines(text)
    if (!lines.length) return
    const report = await sendSplitting(lines, async (part, sub) => {
      try {
        await guard.platform.reply(session, h.text(renderLines(part, sub)))
        return 'sent'
      } catch (error) {
        guard.logger.warn('命令回复发送失败：%s', error)
        return classifySendError(error)
      }
    }, { label, hide: hideNames })
    if (report.split) guard.logger.warn('命令回复%s%s', label ? `（${label}）` : '', describeSplit(report))
  }

  /**
   * 回复一段文字：超过 1500 字（或名单超过 20 行、约 800 字）就分成几条发（带（1/N）序号），最多 5 条；
   * 更长的只发前 4 条，第 5 条说明其余见日志，完整内容写进 Koishi 日志。
   * 由插件自己发（返回空字符串，Koishi 就不再发），这样才看得出有没有被 QQ 拒收。
   */
  const reply = async (session: Session | undefined, text: string) => {
    const parts = splitMessage(text, MAX_MESSAGE_CHARS, { lines: MAX_LIST_LINES, chars: MAX_LIST_CHARS })
    if (!session) return h.text(parts.join('\n'))
    let shown = parts
    if (parts.length > MAX_REPLY_PARTS) {
      guard.logger.info('命令回复太长，完整内容：\n%s', text)
      shown = [...parts.slice(0, MAX_REPLY_PARTS - 1), '……内容太长，其余见 Koishi 日志']
    }
    for (const part of shown) await send(session, part)
    return ''
  }

  const define = (decl: string, description: string) =>
    ctx.command(decl, description, { authority: 3 }).before(gate as any)

  define('aaqq', 'AA QQ 群管理').action(({ session }) => reply(session, [
    'AA QQ 群管理命令：',
    'aaqq.status　查看状态',
    'aaqq.health　检查与 AA 的连接',
    'aaqq.patrol [群号]　立即巡检（不填群号就巡检全部）',
    'aaqq.confirm <群号>　提前结束冷静等待（可选，平时不用）',
    'aaqq.check <QQ号>　查询某个 QQ 的判定',
    'aaqq.pause　紧急暂停（停止一切审批、提醒、改名片、移出）',
    'aaqq.resume　恢复',
  ].join('\n')))

  define('aaqq.status', '查看状态').action(async ({ session }) => reply(session, await guard.statusText()))

  define('aaqq.health', '检查与 AA 的连接').action(async ({ session }) => reply(session, await guard.checkHealth(false)))

  define('aaqq.patrol [group:string]', '立即巡检').action(async ({ session }, group) => {
    if (guard.paused) return reply(session, '插件暂停中，先发送 aaqq.resume 恢复。')
    let only: string[] | undefined
    if (group) {
      const groupId = normalizeId(group)
      if (!groupId || !guard.group(groupId)) return reply(session, `${group} 不是 AA 上的受管群。`)
      only = [groupId]
    }
    if (guard.patrolRunning) {
      guard.requestPatrol(only)
      return reply(session, '正在巡检中，这一轮结束后会马上再巡检一次。')
    }
    guard.requestPatrol(only)
    return reply(session, '已开始巡检，结果会发到运维群。')
  })

  define('aaqq.confirm <group:string>', '提前结束冷静等待').action(async ({ session }, group) => {
    const groupId = normalizeId(group)
    if (!groupId) return reply(session, '用法：aaqq.confirm 群号（只在群处于冷静期时有用，提前结束等待，马上巡检）')
    return reply(session, await guard.confirm(groupId, session?.userId ?? ''))
  })

  define('aaqq.check <qq:string>', '查询某个 QQ 的判定').action(async ({ session }, qq) => {
    const id = normalizeId(qq)
    if (!id) return reply(session, '用法：aaqq.check QQ号（5–11 位数字）')
    return reply(session, await guard.checkQq(id))
  })

  define('aaqq.pause', '紧急暂停').action(async ({ session }) => {
    await guard.setPaused(true, session?.userId ?? '')
    return reply(session, '⏸ 已暂停：正在进行的巡检已中止；在恢复之前不会审批、提醒、改名片或移出任何人（入群申请留给管理员）。发送 aaqq.resume 恢复。')
  })

  define('aaqq.resume', '恢复').action(async ({ session }) => {
    await guard.setPaused(false, session?.userId ?? '')
    return reply(session, '▶ 已恢复，马上巡检一次。')
  })
}
