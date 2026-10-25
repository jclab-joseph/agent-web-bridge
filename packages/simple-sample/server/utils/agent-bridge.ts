import { homedir } from 'node:os'
import { AgentBridge, createNodeHandler } from '@agent-web-bridge/server'
import { createClaudeCodeProvider } from '@agent-web-bridge/server/claude-code'
import { SqliteSessionStore } from './sqlite-session-store'

const globalState = globalThis as { __agentBridge?: AgentBridge }

/** One bridge per server process, kept across dev hot reloads. */
export function getAgentBridge(): AgentBridge {
  if (!globalState.__agentBridge) {
    const config = useRuntimeConfig().agentBridge
    const allowedRoots = config.allowedRoots ? list(config.allowedRoots) : [homedir()]
    globalState.__agentBridge = new AgentBridge({
      providers: [
        createClaudeCodeProvider({
          // Merged onto process.env; `undefined` would remove a variable.
          env: { CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-web-bridge-sample' },
          // Computed per session; `session.meta` would carry e.g. the user who created it.
          queryOptions: () => ({
            allowedTools: list(config.allowedTools),
            disallowedTools: list(config.disallowedTools),
          }),
        }),
      ],
      store: new SqliteSessionStore(config.dbPath),
      sessionTtlMs: Number(config.sessionTtlMs),
      allowedRoots,
    })
  }
  return globalState.__agentBridge
}

function list(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export const agentBridgeHandler = () => createNodeHandler(getAgentBridge(), { basePath: '/api/agent' })
