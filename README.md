# agent-web-bridge

Run AI coding agents (currently Claude Code, through the Claude Agent SDK) on a server and use them from a web page. Both halves are libraries you mount in your own app.

- Multiple concurrent sessions, each in its own working directory
- Streamed replies rendered as markdown, tool calls, and tool permission prompts (allow / always allow / deny)
- Permission modes Ask, Accept edits, Plan and Auto (a classifier approves routine actions and asks about the rest); Bypass only when the host enables it. Mode changes Claude Code makes itself, such as leaving plan mode, show up in the UI
- Model and reasoning effort chosen per session and changeable while it runs
- Questions from the agent (Claude's `AskUserQuestion`) answered in the UI; plans from plan mode shown for approval
- Image attachments (button, paste, or drag and drop; downscaled in the browser)
- Subagent transcripts nested under the tool call that started them
- Idle sessions are suspended after a TTL (default 5 minutes) and resumed with their context on the next message
- Pluggable storage (`SessionStore`) and pluggable agents (`AgentProvider`)

| Package | What it is |
|---|---|
| [`@agent-web-bridge/server`](packages/server) | Session manager, TTL/resume, HTTP + SSE handler, in-memory store |
| [`@agent-web-bridge/server/claude-code`](packages/server/src/providers/claude-code.ts) | Claude Agent SDK provider (needs `@anthropic-ai/claude-agent-sdk`) |
| [`@agent-web-bridge/vue`](packages/vue) | Client (`useAgentBridge`) and UI components |
| [`@agent-web-bridge/protocol`](packages/protocol) | Wire types shared by server and client |
| [`simple-sample`](packages/simple-sample) | Nuxt app using all of the above, with a SQLite store |

> **Security:** an agent can read and write files and run commands on the server. The handler has no authentication of its own; put it behind yours, and limit `allowedRoots`.

## Run the sample

Requires Node 24 and pnpm. Claude Code must be logged in on the machine (or `ANTHROPIC_API_KEY` set).

```sh
pnpm install
pnpm dev            # http://localhost:3000
```

Configuration (environment variables):

| Variable | Default |
|---|---|
| `NUXT_AGENT_BRIDGE_ALLOWED_ROOTS` | your home directory (comma-separated list) |
| `NUXT_AGENT_BRIDGE_SESSION_TTL_MS` | `300000` |
| `NUXT_AGENT_BRIDGE_DB_PATH` | `.data/agent-web-bridge.db` |
| `NUXT_AGENT_BRIDGE_ALLOWED_TOOLS` | none; Claude Code permission rules run without asking, e.g. `Write,Bash(npm test:*)` |
| `NUXT_AGENT_BRIDGE_DISALLOWED_TOOLS` | none; tools removed from the agent |
| `NUXT_PUBLIC_AGENT_BRIDGE_DEFAULT_CWD` | your home directory |

## Server

```ts
import { AgentBridge, createFetchHandler, createNodeHandler } from '@agent-web-bridge/server'
import { createClaudeCodeProvider } from '@agent-web-bridge/server/claude-code'

const bridge = new AgentBridge({
  providers: [createClaudeCodeProvider()],
  store: myStore,                 // optional, defaults to MemorySessionStore
  sessionTtlMs: 5 * 60 * 1000,    // optional
  allowedRoots: ['/srv/projects'], // optional, restricts session working directories
})

// Fetch API (Hono, Bun, Next route handlers, ...): returns undefined for paths it does not own
const handle = createFetchHandler(bridge, { basePath: '/api/agent' })

// Node http / express
app.use('/api/agent', createNodeHandler(bridge, { basePath: '/api/agent' }))
```

In Nuxt/Nitro, see [`server/api/agent/[...path].ts`](packages/simple-sample/server/api/agent/[...path].ts) and [`server/utils/agent-bridge.ts`](packages/simple-sample/server/utils/agent-bridge.ts). Call `bridge.close()` on shutdown to stop agent processes.

### Controlling the Claude Code process

Everything the Agent SDK accepts can be set by the host, statically or per session:

```ts
createClaudeCodeProvider({
  // Object, or a function of the session ({ sessionId, cwd, model, permissionMode, resume, meta })
  queryOptions: (session) => ({
    allowedTools: ['Read', 'Bash(npm test:*)'],      // run without asking
    disallowedTools: ['WebFetch'],                     // removed from the agent
    additionalDirectories: ['/srv/shared'],
    extraArgs: { 'strict-mcp-config': null },          // any other `claude` CLI flag (null = boolean flag)
    settings: { permissions: { deny: ['Read(./.env)'] } },
    settingSources: ['project'],                       // which settings files to load
    mcpServers: {}, hooks: {}, systemPrompt: { type: 'preset', preset: 'claude_code', append: '…' },
    pathToClaudeCodeExecutable: '/usr/local/bin/claude',
  }),
  // Merged onto process.env (the SDK's own `env` option replaces the environment); undefined removes a variable
  env: { ANTHROPIC_API_KEY: process.env.TEAM_KEY, DEBUG: undefined },
  // Settle a permission request on the server; return undefined to ask the user
  authorizeTool: ({ toolName, input, session }) =>
    toolName === 'Bash' && String(input.command).includes('rm -rf') ? { behavior: 'deny', message: 'Not allowed' } : undefined,
  models: [/* … */],               // what clients may choose; the server rejects anything else
  permissionModes: [/* … */],
  efforts: [/* … */],              // reasoning effort levels, e.g. low … max
  allowBypassPermissions: false,   // true offers the mode that runs every tool without asking
})
```

`meta` comes from the host, never from the client: `createFetchHandler(bridge, { sessionMeta: async (request) => ({ user: await getUser(request) }) })` stores it with each new session and hands it to `queryOptions` every time the session's process starts, so options can depend on who created the session. The cwd, model, permission mode and effort are managed by the bridge; values requested by clients are checked against `models` / `permissionModes` / `efforts`.

**Bundling:** the Agent SDK starts a native `claude` binary from a platform-specific optional package. Keep `@anthropic-ai/claude-agent-sdk` external and installed with optional dependencies; the sample sets `nitro.externals.trace: false` for this.

### Routes

| | |
|---|---|
| `GET {base}/events` | Server-sent events: `hello` (agents, sessions, server time) on every connect, then `session.updated`, `session.deleted`, `message.upsert` |
| `GET {base}/sessions/:id/messages` | Transcript of a session |
| `POST {base}/commands` | A `ClientCommand`: `session.create`, `send` (text and images), `interrupt`, `update`, `permission` (decision and question answers), `suspend`, `delete`. Bodies over `maxBodyBytes` (30 MB) are rejected |

### Session lifecycle

`starting` → `idle` ⇄ `busy` ⇄ `awaiting_permission`. A session that stays `idle` or `awaiting_permission` for the TTL is stopped and becomes `suspended`; its transcript stays in the store, and the next message restarts the agent with `resume`. After a server restart every stored session is `suspended`. `busy` sessions never expire.

### Storage

Implement [`SessionStore`](packages/server/src/store.ts) (6 methods) for your database. [`SqliteSessionStore`](packages/simple-sample/server/utils/sqlite-session-store.ts) in the sample uses Node's built-in `node:sqlite`.

### Adding another agent

Implement [`AgentProvider`](packages/server/src/agent.ts): `info` describes the agent (models, permission modes, effort levels), and `start()` returns an `AgentRuntime` that emits `message`, `status`, `provider_session` and `exit` events. The [Claude Code provider](packages/server/src/providers/claude-code.ts) is the reference.

## Vue

```vue
<script setup lang="ts">
import { AgentChat, SessionList, useAgentBridge } from '@agent-web-bridge/vue'
import '@agent-web-bridge/vue/style.css'

const bridge = useAgentBridge({ baseUrl: '/api/agent' })
const { state } = bridge // reactive: connected, agents, sessions, messages
// bridge.loadMessages(id) before showing a session; bridge.create/send/interrupt/update/respondPermission/suspend/remove
</script>
```

Components take data through props and report actions as events, so they fit any layout: `SessionList`, `AgentChat` (or its parts `SessionHeader`, `MessageList`, `Composer`), `NewSessionDialog`, `MessageItem`, `ToolCallCard`, `QuestionForm`, `MarkdownText`, `StatusBadge`. Theme them by overriding the `--awb-*` CSS variables. See [`app.vue`](packages/simple-sample/app/app.vue) for a complete page.

Markdown is rendered with markdown-it with raw HTML disabled, so agent output cannot inject markup.

## Building and publishing

Inside the workspace the packages export their TypeScript sources, so the sample needs no build step. `pnpm build` builds the libraries into `dist/` (tsdown for `protocol` and `server`, Vite and vue-tsc for `vue`); on `pnpm publish`, `publishConfig` points `exports` at `dist/` and `workspace:*` dependencies become version numbers. `prepublishOnly` runs the build.

```sh
pnpm build
pnpm -r --filter "./packages/*" --filter "!simple-sample" publish --access public
```

## Known limits

- Transcripts store attached images inline (base64), which makes transcripts with many images large.
- Every connected client sees every session; scope sessions per user in your host if you need that.
- Claude Code may run subagents in the background: the tool call returns at once and the subagent's messages arrive later.
