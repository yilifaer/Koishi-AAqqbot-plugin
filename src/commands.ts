// 管理命令。必须同时满足三个条件才能用（DECISIONS 第 10 条、交接文档 R13）：
//   ① 在运维群里或私聊机器人；② QQ 在运维名单里；③ Koishi 权限等级 ≥ 3。
// 在其他任何群（包括受管群）里发命令，一律不回应。

import { Argv, Context, h } from 'koishi'
import type { Guard } from './guard'
import { normalizeId } from './util'

export function registerCommands(ctx: Context, guard: Guard) {
  const gate = ({ session }: Argv) => {
    if (!session || session.platform !== 'onebot') return ''
    const admin = guard.adminGroup()
    const inPrivate = session.isDirect
    const inAdminGroup = !session.isDirect && !!admin && normalizeId(session.guildId) === admin
    if (!inPrivate && !inAdminGroup) return '' // 不回应
    const qq = normalizeId(session.userId)
    if (!qq || !guard.operators().has(qq)) return h.text('你不在运维名单里，不能使用这个命令。')
    // 返回 undefined 表示继续，接下来由 Koishi 检查权限等级（authority: 3）
  }

  const define = (decl: string, description: string) =>
    ctx.command(decl, description, { authority: 3 }).before(gate as any)

  define('aaqq', 'AA QQ 群管理').action(() => h.text([
    'AA QQ 群管理命令：',
    'aaqq.status　查看状态',
    'aaqq.health　检查与 AA 的连接',
    'aaqq.patrol [群号]　立即巡检（不填群号就巡检全部）',
    'aaqq.confirm <群号>　确认模式升级 / 解除熔断',
    'aaqq.check <QQ号>　查询某个 QQ 的判定',
    'aaqq.pause　紧急暂停（停止一切审批、提醒、改名片、移出）',
    'aaqq.resume　恢复',
  ].join('\n')))

  define('aaqq.status', '查看状态').action(async () => h.text(await guard.statusText()))

  define('aaqq.health', '检查与 AA 的连接').action(async () => h.text(await guard.checkHealth(false)))

  define('aaqq.patrol [group:string]', '立即巡检').action(async (_, group) => {
    if (guard.paused) return h.text('插件暂停中，先发送 aaqq.resume 恢复。')
    let only: string[] | undefined
    if (group) {
      const groupId = normalizeId(group)
      if (!groupId || !guard.group(groupId)) return h.text(`${group} 不是 AA 上的受管群。`)
      only = [groupId]
    }
    if (guard.patrolRunning) {
      guard.requestPatrol(only)
      return h.text('正在巡检中，这一轮结束后会马上再巡检一次。')
    }
    guard.requestPatrol(only)
    return h.text('已开始巡检，结果会发到运维群。')
  })

  define('aaqq.confirm <group:string>', '确认模式升级 / 解除熔断').action(async ({ session }, group) => {
    const groupId = normalizeId(group)
    if (!groupId) return h.text('用法：aaqq.confirm 群号')
    return h.text(await guard.confirm(groupId, session?.userId ?? ''))
  })

  define('aaqq.check <qq:string>', '查询某个 QQ 的判定').action(async (_, qq) => {
    const id = normalizeId(qq)
    if (!id) return h.text('用法：aaqq.check QQ号（5–11 位数字）')
    return h.text(await guard.checkQq(id))
  })

  define('aaqq.pause', '紧急暂停').action(async ({ session }) => {
    await guard.setPaused(true, session?.userId ?? '')
    return h.text('⏸ 已暂停：正在进行的巡检已中止；在恢复之前不会审批、提醒、改名片或移出任何人（入群申请留给管理员）。发送 aaqq.resume 恢复。')
  })

  define('aaqq.resume', '恢复').action(async ({ session }) => {
    await guard.setPaused(false, session?.userId ?? '')
    return h.text('▶ 已恢复，马上巡检一次。')
  })
}
