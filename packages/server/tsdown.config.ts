import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', 'claude-code': 'src/providers/claude-code.ts' },
  platform: 'node',
  dts: true,
})
