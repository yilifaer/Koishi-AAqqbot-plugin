import { Context } from 'koishi'
import { registerCommands } from './commands'
import { Config } from './config'
import { Guard } from './guard'

export const name = 'aaqqbot'

// 数据库：保存宽限记录、游标、暂停状态；没有数据库时 Koishi 的权限检查会完全失效（交接文档 03 #26）
export const inject = { required: ['database', 'http'] }

export { Config }

export const usage = `
配合 AllianceAuth 插件 **aa-qqbot** 管理联盟 QQ 群：审批入群申请、定时巡检、@ 提醒、名片加标记、移出不合格成员、同步群名片。

**第一次使用：**

1. 在 AA 上装好 aa-qqbot，由 IT 在 \`local.py\` 里配置 \`QQBOT_API_KEYS\`（密钥编号 → 密钥）。
2. 在下面填好「AA 的网址」「密钥编号」「密钥」，以及运维群号、运维名单。
3. 启用插件后，在运维群里发送 \`aaqq.health\` 检查连接，发送 \`aaqq.status\` 查看受管群。
4. 所有群默认 **report（只报告）**：机器人只审批合格的入群申请，并把巡检结果发到运维群，不改动群里任何东西。
5. 看过报告、确认没问题后，再把某个群改成 remind 或 enforce，并在运维群发送 \`aaqq.confirm 群号\` 确认。

**安全保证：** AA 连不上、返回异常或判定为「需要人工处理」时，机器人什么都不做；群主、管理员、机器人自己和白名单永远不会被处置；
一轮里新发现的不合格人数太多时自动熔断，等管理员确认。紧急情况发送 \`aaqq.pause\` 立即停止一切操作。

详细说明见 [README](https://github.com/yilifaer/Koishi-AAqqbot-plugin#readme)。
`

export function apply(ctx: Context, config: Config) {
  const guard = new Guard(ctx, config)
  guard.install()
  registerCommands(ctx, guard)
}
