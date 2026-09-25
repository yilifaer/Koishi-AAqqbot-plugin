import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

// Koishi 4.18 的 ESM 入口在 Node 22 下无法加载；Koishi Desktop 实际走的是 CommonJS，测试也用 CommonJS 入口。
const cjs = (name: string) => ({ find: new RegExp(`^${name.replace(/[/]/g, '\\/')}$`), replacement: require.resolve(name) })

export default defineConfig({
  resolve: {
    alias: [
      cjs('koishi'),
      cjs('@koishijs/plugin-http'),
      cjs('@koishijs/plugin-database-memory'),
      cjs('koishi-plugin-adapter-onebot'),
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    env: { TZ: 'Asia/Shanghai' },
  },
})
