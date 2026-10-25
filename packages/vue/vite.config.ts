import { readFileSync } from 'node:fs'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'
import pkg from './package.json' with { type: 'json' }

const external = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]

/** The stylesheet is imported by consumers, not by the components, so emit it as is. */
const stylesheet: Plugin = {
  name: 'awb-stylesheet',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'style.css', source: readFileSync('src/style.css', 'utf8') })
  },
}

// Library build; type declarations come from vue-tsc (see tsconfig.build.json).
export default defineConfig({
  plugins: [vue(), stylesheet],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    rollupOptions: { external: (id) => external.some((dep) => id === dep || id.startsWith(`${dep}/`)) },
    copyPublicDir: false,
  },
})
