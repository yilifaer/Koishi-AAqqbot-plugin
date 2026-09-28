import { describe, expect, it } from 'vitest'
import { OneBot } from 'koishi-plugin-adapter-onebot'
import { pack } from '../src/notifier'
import { charLength, cleanName, displayName, isOneBotRefusal, isOneBotTimeout, MAX_MESSAGE_CHARS, splitMessage } from '../src/util'

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
