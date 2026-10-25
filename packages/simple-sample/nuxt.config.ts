import { homedir } from 'node:os'

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  // Agent sessions are live client state; nothing useful to server-render.
  ssr: false,
  devtools: { enabled: false },
  css: ['@agent-web-bridge/vue/style.css'],
  build: { transpile: ['@agent-web-bridge/vue'] },
  app: { head: { title: 'agent-web-bridge sample' } },
  nitro: {
    // The Agent SDK loads its native `claude` binary from a platform package that
    // dependency tracing does not find, so resolve dependencies from node_modules at runtime.
    externals: { trace: false },
  },
  // Override with NUXT_AGENT_BRIDGE_DB_PATH, NUXT_AGENT_BRIDGE_ALLOWED_ROOTS (comma-separated), ...
  runtimeConfig: {
    agentBridge: {
      dbPath: '.data/agent-web-bridge.db',
      allowedRoots: '',
      sessionTtlMs: 5 * 60 * 1000,
      // Claude Code permission rules, e.g. "Bash(npm test:*),Read"; comma-separated.
      allowedTools: '',
      disallowedTools: '',
    },
    public: {
      agentBridge: { defaultCwd: homedir() },
    },
  },
})
