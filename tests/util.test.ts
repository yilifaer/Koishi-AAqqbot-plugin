import { describe, expect, it } from 'vitest'
import { OneBot } from 'koishi-plugin-adapter-onebot'
import { describeSplit, renderLines, SendResult, sendSplitting, textLines } from '../src/delivery'
import { HIDDEN_NAME, hideNames, pack } from '../src/notifier'
import {
  charLength, cleanName, countListLines, displayName, isListLine, isOneBotRefusal, isOneBotTimeout, MAX_LIST_CHARS, MAX_LIST_LINES,
  MAX_MESSAGE_CHARS, splitMessage,
} from '../src/util'

// 看不见的字符都用 String.fromCodePoint 写，不直接粘贴
const ZWSP = String.fromCodePoint(0x200b)
const HANGUL_FILLER = String.fromCodePoint(0x3164)
const FULL_SPACE = String.fromCodePoint(0x3000)

describe('名字显示（K7 / K8）', () => {
  it('去掉零宽字符、韩文填充符、全角空格；名字中间的空格保留', () => {
    expect(cleanName(`${ZWSP} ${HANGUL_FILLER}${FULL_SPACE}`)).toBe('')
    expect(cleanName(`${FULL_SPACE}Kaela Voss${ZWSP}`)).toBe('Kaela Voss')
    expect(cleanName('[IGC] 张 三')).toBe('[IGC] 张 三')
  })

  it('名片空白时用昵称；都空时返回空字符串', () => {
    expect(displayName(`${ZWSP} ${HANGUL_FILLER}`, '小明', '【SPY】')).toBe('小明')
    expect(displayName(' ', ` ${ZWSP}`, '【SPY】')).toBe('')
  })

  it('去掉名字前面的标记', () => {
    expect(displayName('【SPY】Leito', 'x', '【SPY】')).toBe('Leito')
    expect(displayName('【SPY】', '小明', '【SPY】')).toBe('小明')
    expect(displayName('张三', 'x', '')).toBe('张三')
  })
})

describe('OneBot 错误（K9）', () => {
  it('分得清超时和拒绝', () => {
    const timeout = new OneBot.TimeoutError({ group_id: 1 }, 'get_group_member_list')
    expect(isOneBotTimeout(timeout)).toBe(true)
    expect(isOneBotRefusal(timeout)).toBe(false)
    const refusal = new Error('Error with request set_group_card, args: {}, retcode: 102')
    expect(isOneBotTimeout(refusal)).toBe(false)
    expect(isOneBotRefusal(refusal)).toBe(true)
    expect(isOneBotTimeout(new Error('别的错误'))).toBe(false)
    expect(isOneBotRefusal(new Error('别的错误'))).toBe(false)
    expect(isOneBotTimeout('Timeout with request x')).toBe(false)
  })
})

describe('消息分段（K13）', () => {
  it('短文本：1 条，没有序号', () => {
    expect(splitMessage('你好')).toEqual(['你好'])
  })

  it('3000 字、有空行：在空行处切成 2 条，带（1/2）（2/2），每条不超过 1500 字', () => {
    const block = (ch: string) => Array.from({ length: 10 }, () => ch.repeat(140)).join('\n')
    const text = `${block('甲')}\n\n${block('乙')}`
    expect(charLength(text)).toBeGreaterThan(2800)
    const parts = splitMessage(text)
    expect(parts).toHaveLength(2)
    expect(parts[0].startsWith('（1/2）')).toBe(true)
    expect(parts[1].startsWith('（2/2）')).toBe(true)
    expect(parts[0]).not.toContain('乙')
    expect(parts[1]).not.toContain('甲')
    for (const part of parts) expect(charLength(part)).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
  })

  it('一行 2000 字没有换行：硬切，不切断汉字或 emoji', () => {
    const text = '汉😀'.repeat(1000)
    const parts = splitMessage(text)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const part of parts) {
      expect(charLength(part)).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
      expect(part).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(part).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    }
    expect(parts[0].endsWith('…')).toBe(true)
    const joined = parts.map((p) => p.replace(/^（\d+\/\d+）/, '').replace(/…$/, '')).join('')
    expect(joined).toBe(text)
  })
})

describe('运维通知打包（K13）', () => {
  it('一份 4000 字的报告：3 条，带 1/3、2/3、3/3', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `· 第 ${i} 行 ${'字'.repeat(90)}`)
    const report = lines.join('\n')
    expect(charLength(report)).toBeGreaterThan(3900)
    const messages = pack([report])
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.slice(0, 5))).toEqual(['（1/3）', '（2/3）', '（3/3）'])
    for (const m of messages) expect(charLength(m)).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
  })

  it('几条短通知合并成 1 条，没有序号', () => {
    const messages = pack(['第一条', '第二条', '第三条'])
    expect(messages).toEqual(['第一条\n\n第二条\n\n第三条'])
  })

  it('短通知在前、长报告在后：短的单独一条，长的自己编号', () => {
    const report = Array.from({ length: 40 }, () => '字'.repeat(100)).join('\n')
    const messages = pack(['短通知', report])
    expect(messages[0]).toBe('短通知')
    expect(messages[1].startsWith('（1/')).toBe(true)
  })
})

describe('名单分短（0.2.4 M1）', () => {
  /** 仿照巡检报告：groups 个群，每群 perGroup 个「· 名字(QQ)」。 */
  function report(groups: number, perGroup: number) {
    let qq = 40000
    const sections = Array.from({ length: groups }, (_, g) => [
      `▶ 第${g + 1}群（${100000000 + g}）　enforce（提醒并移出）`,
      `成员 ${perGroup + 3}（不含机器人）：合格 3｜不合格 ${perGroup}｜需人工 0｜无法判断 0`,
      `仍不合格 ${perGroup} 人`,
      '【没有在 AA 绑定 QQ】',
      ...Array.from({ length: perGroup }, () => `· [IGC] 某某某 - 名字${++qq}(${qq})`),
    ].join('\n'))
    return ['【AA 巡检】09-29 03:50 完成，用时 12 秒', ...sections].join('\n\n')
  }
  const names = (text: string) => text.match(/\(\d{5,12}\)/g) ?? []

  it('认得出名单行：带「(QQ号)」的行；群号的全角括号、「· 同步名片 2 人」不算', () => {
    expect(isListLine('· 张三(12345678)')).toBe(true)
    expect(isListLine('⚡ 联盟聊天群（111111111） 张三(40001) 已不具备成员资格')).toBe(true)
    expect(isListLine('▶ 联盟聊天群（111111111）　enforce')).toBe(false)
    expect(isListLine('· 同步名片 2 人（其中群主/管理员 2 人）')).toBe(false)
  })

  it('不给名单上限时照旧（只按 1500 字分）', () => {
    const text = report(1, 35)
    expect(charLength(text)).toBeLessThan(MAX_MESSAGE_CHARS)
    expect(splitMessage(text)).toEqual([text])
  })

  it('4 个群、每群 20 人的报告：每条最多 20 行名单、不超过 800 字，名单一个不少、顺序不变，带（i/N）', () => {
    const text = report(4, 20)
    const parts = splitMessage(text, MAX_MESSAGE_CHARS, { lines: MAX_LIST_LINES, chars: MAX_LIST_CHARS })
    expect(parts.length).toBeGreaterThanOrEqual(4)
    parts.forEach((part, i) => {
      expect(part.startsWith(`（${i + 1}/${parts.length}）`)).toBe(true)
      expect(countListLines(part)).toBeLessThanOrEqual(MAX_LIST_LINES)
      expect(charLength(part)).toBeLessThanOrEqual(MAX_LIST_CHARS)
    })
    expect(parts.flatMap(names)).toEqual(names(text))
  })

  it('一个群 50 人：同一小节也会在行之间切开', () => {
    const text = report(1, 50)
    const parts = splitMessage(text, MAX_MESSAGE_CHARS, { lines: MAX_LIST_LINES, chars: MAX_LIST_CHARS })
    expect(parts.length).toBeGreaterThanOrEqual(3)
    for (const part of parts) expect(countListLines(part)).toBeLessThanOrEqual(MAX_LIST_LINES)
    expect(parts.flatMap(names)).toEqual(names(text))
  })
})

describe('运维通知打包：名单（0.2.4 M1）', () => {
  it('30 条「⚡ … 名字(QQ) …」短通知：合并时每条最多 20 行名单，一条不少', () => {
    const items = Array.from({ length: 30 }, (_, i) => `⚡ 联盟聊天群（111111111） 名字${i}(${40001 + i}) 已不具备成员资格（AA 账号没有成员资格），已提醒，9月29日 12:00 移出`)
    const messages = pack(items)
    expect(messages.length).toBeGreaterThanOrEqual(2)
    for (const m of messages) {
      expect(countListLines(m)).toBeLessThanOrEqual(MAX_LIST_LINES)
      expect(charLength(m)).toBeLessThanOrEqual(MAX_LIST_CHARS)
    }
    expect(messages.join('\n\n')).toBe(items.join('\n\n'))
  })

  it('一份 40 行短名单（字数不到 800）：照样按每条最多 20 行名单切开', () => {
    const report = Array.from({ length: 40 }, (_, i) => `· 张三${40001 + i}(${40001 + i})`).join('\n')
    expect(charLength(report)).toBeLessThan(MAX_LIST_CHARS)
    const messages = pack([report])
    expect(messages.length).toBeGreaterThanOrEqual(2)
    for (const m of messages) expect(countListLines(m)).toBeLessThanOrEqual(MAX_LIST_LINES)
  })

  it('序号也算在 800 字里：切成 10 条以上、序号两位数时每条仍不超过 800 字', () => {
    const report = Array.from({ length: 200 }, (_, i) => `· ${'名'.repeat(40)}(${40001 + i})`).join('\n')
    const messages = pack([report])
    expect(messages.length).toBeGreaterThanOrEqual(10)
    for (const m of messages) expect(charLength(m)).toBeLessThanOrEqual(MAX_LIST_CHARS)
  })

  it('一行里有好几个「名字(QQ号)」：按好几行名单算', () => {
    expect(countListLines('· 张三(12345678)、李四(23456789)\n· 王五(34567890)')).toBe(3)
  })

  it('没有名单的短通知照旧合并成 1 条', () => {
    const items = Array.from({ length: 10 }, (_, i) => `ℹ 第 ${i} 条通知 ${'字'.repeat(60)}`)
    expect(pack(items)).toHaveLength(1)
  })
})

describe('隐藏名字（0.2.4 M1）', () => {
  it('「· 名字(QQ)」：名字换掉，QQ 号和后面的说明保留', () => {
    expect(hideNames('· 坏词张三(40001)（群主，不移出）')).toBe(`· ${HIDDEN_NAME}(40001)（群主，不移出）`)
  })

  it('⚡ 那一行：开头的符号、群名、后面的说明都保留，只隐藏名字', () => {
    expect(hideNames('⚡ 联盟聊天群（111111111） 坏词张三(40001) 已不具备成员资格（AA 账号没有成员资格），已提醒'))
      .toBe(`⚡ 联盟聊天群（111111111） ${HIDDEN_NAME}(40001) 已不具备成员资格（AA 账号没有成员资格），已提醒`)
  })

  it('一行里有好几个名字（用「：」「、」隔开）：每个名字都隐藏，前面的说明保留', () => {
    expect(hideNames('⚠ 没有生效：张三(12345678)、李四(23456789)（每一条只能填一个 QQ 号）'))
      .toBe(`⚠ 没有生效：${HIDDEN_NAME}(12345678)、${HIDDEN_NAME}(23456789)（每一条只能填一个 QQ 号）`)
  })

  it('名字里自己带括号：整个名字都隐藏', () => {
    expect(hideNames('· 张三(备注)(40001)')).toBe(`· ${HIDDEN_NAME}(40001)`)
  })

  it('名片那一行：箭头后面要改成的名片也隐藏', () => {
    expect(hideNames('· 坏词管理员(10002) → [IGC] 坏词管理员')).toBe(`· ${HIDDEN_NAME}(10002) → ${HIDDEN_NAME}`)
  })

  it('emoji 开头、名字里有空格', () => {
    expect(hideNames('👋 联盟聊天群（111111111） 新成员 [IGC] Kaela Voss(40001)：合格。')).toBe(`👋 联盟聊天群（111111111） 新成员 ${HIDDEN_NAME}(40001)：合格。`)
  })

  it('没有 QQ 号的行：没有名字可以隐藏', () => {
    expect(hideNames('【没有在 AA 绑定 QQ】')).toBeNull()
    expect(hideNames('测试通知')).toBeNull()
  })
})


describe('拆小重发（0.2.4 M1）', () => {
  /** 模拟发送：refuse 返回 true 的就拒收，记下每次发了什么。 */
  function sender(refuse: (part: string[]) => boolean) {
    const sent: string[] = []
    const tried: string[] = []
    const send = async (part: string[], label: string): Promise<SendResult> => {
      const text = renderLines(part, label)
      tried.push(text)
      if (refuse(part)) return 'refused'
      sent.push(text)
      return 'sent'
    }
    return { sent, tried, send }
  }

  it('被拒就对半拆开，直到送达；序号接着原来的编', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `· 名字${i}(${40001 + i})`)
    const { sent, send } = sender((part) => part.length > 2)
    const report = await sendSplitting(lines, send, { label: '3/4', hide: hideNames })
    expect(sent.map((t) => t.slice(0, 9))).toEqual(['（3/4-1-1）', '（3/4-1-2）', '（3/4-2-1）', '（3/4-2-2）'])
    expect(sent.flatMap((t) => t.match(/\(\d+\)/g))).toEqual(lines.map((l) => l.match(/\(\d+\)/)![0]))
    expect(report).toMatchObject({ split: true, halved: true, pieces: 4, delivered: 4, lost: 0, hidden: 0 })
    expect(describeSplit(report)).toBe('被 QQ 拒收，拆成 4 条重发，全部送达')
  })

  it('原来没有序号的：拆出来是（1/1-1）（1/1-2）', async () => {
    const { sent, send } = sender((part) => part.length > 1)
    await sendSplitting(['第一行', '第二行'], send, { hide: hideNames })
    expect(sent).toEqual(['（1/1-1）第一行', '（1/1-2）第二行'])
  })

  it('单独一行还被拒：隐藏名字后只再发一次；还被拒就放弃，交给 onLost 写日志（给的是原来的内容）', async () => {
    const lost: Array<[string[], string, SendResult]> = []
    const { tried, send } = sender((part) => part.some((line) => line.includes('(40002)')))
    const report = await sendSplitting(['· 甲(40001)', '· 乙(40002)'], send, { label: '1/2', hide: hideNames, onLost: (...args) => lost.push(args) })
    expect(tried.filter((t) => t.includes(HIDDEN_NAME))).toHaveLength(1)
    expect(lost).toEqual([[['· 乙(40002)'], '1/2-2', 'refused']])
    expect(report).toMatchObject({ pieces: 2, delivered: 1, lost: 1, hidden: 0 })
    expect(describeSplit(report)).toBe('被 QQ 拒收，拆成 2 条重发，没有全部送达：1 条送达，1 条没发出（内容见前面的日志）')
  })

  it('只有 1 行的消息被拒、又没有名字可以隐藏：说「没法拆开」，不说拆成几条', async () => {
    const { send } = sender(() => true)
    const report = await sendSplitting(['✅ AA 已恢复连接。'], send, { hide: hideNames })
    expect(describeSplit(report)).toBe('被 QQ 拒收，只有 1 行，没法拆开，没有全部送达：0 条送达，1 条没发出（内容见前面的日志）')
  })

  it('超时、其他失败都不拆', async () => {
    for (const result of ['timeout', 'failed', 'capped'] as const) {
      let calls = 0
      const report = await sendSplitting(['一', '二', '三'], async () => {
        calls++
        return result
      })
      expect(calls).toBe(1)
      expect(report.split).toBe(false)
    }
  })

  it('序号和各行拆开再拼回去：内容不变，小节之间的空行还在', () => {
    const text = '（2/3）标题\n\n【分类】\n· 甲(40001)\n\n· 乙(40002)'
    const { label, lines } = textLines(text)
    expect(label).toBe('2/3')
    expect(renderLines(lines, label)).toBe(text)
  })
})
