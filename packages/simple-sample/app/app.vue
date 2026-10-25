<script setup lang="ts">
import {
  AgentChat,
  NewSessionDialog,
  SessionList,
  useAgentBridge,
  type CreateSessionRequest,
  type ImageAttachment,
  type PermissionResponse,
} from '@agent-web-bridge/vue'

const bridge = useAgentBridge({ baseUrl: '/api/agent' })
const { state } = bridge
const defaultCwd = useRuntimeConfig().public.agentBridge.defaultCwd

const activeId = ref<string>()
const active = computed(() => state.sessions.find((s) => s.id === activeId.value))
const activeAgent = computed(() => state.agents.find((a) => a.id === active.value?.agentId))
const recentDirs = computed(() => [...new Set(state.sessions.map((s) => s.cwd))])
const creating = ref(false)
const navOpen = ref(false)
const error = ref<string>()

watch(activeId, (id) => id && run(() => bridge.loadMessages(id)))
// Pick the most recent session once the first snapshot arrives.
watch(
  () => state.sessions.length,
  () => {
    if (!active.value) activeId.value = [...state.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id
  },
)

async function run(action: () => Promise<unknown>) {
  try {
    error.value = undefined
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function select(id: string) {
  activeId.value = id
  navOpen.value = false
}

function create(request: CreateSessionRequest) {
  run(async () => select((await bridge.create(request)).id))
}

function remove(id: string) {
  if (!confirm('Delete this session and its transcript?')) return
  run(async () => {
    await bridge.remove(id)
    if (activeId.value === id) activeId.value = undefined
  })
}

// Handlers for the active session.
const on = {
  send: (text: string, images: ImageAttachment[]) => run(() => bridge.send(activeId.value!, text, images)),
  interrupt: () => run(() => bridge.interrupt(activeId.value!)),
  permission: (requestId: string, response: PermissionResponse) =>
    run(() => bridge.respondPermission(activeId.value!, requestId, response)),
  update: (options: { model?: string; permissionMode?: string }) => run(() => bridge.update(activeId.value!, options)),
  suspend: () => run(() => bridge.suspend(activeId.value!)),
}
</script>

<template>
  <div class="layout" :class="{ 'nav-open': navOpen }">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand__name">agent-web-bridge</span>
        <span class="brand__tag">sample</span>
      </div>
      <SessionList
        class="sidebar__list"
        :sessions="state.sessions"
        :active-id="activeId"
        @select="select"
        @create="creating = true"
      />
      <p class="sidebar__foot" :class="{ 'is-offline': !state.connected }">
        {{ state.connected ? 'Connected' : 'Connecting…' }}
      </p>
    </aside>
    <div class="backdrop" @click="navOpen = false" />

    <main class="main">
      <p v-if="error" class="error" role="alert">
        {{ error }}
        <button type="button" aria-label="Dismiss" @click="error = undefined">✕</button>
      </p>
      <AgentChat
        v-if="active"
        :key="active.id"
        :session="active"
        :agent="activeAgent"
        :messages="state.messages[active.id] ?? []"
        @send="on.send"
        @interrupt="on.interrupt"
        @permission="on.permission"
        @update="on.update"
        @suspend="on.suspend"
        @delete="remove(active.id)"
      >
        <template #header-leading>
          <button type="button" class="menu-btn" aria-label="Open sessions" @click="navOpen = true">☰</button>
        </template>
      </AgentChat>
      <div v-else class="placeholder">
        <button type="button" class="menu-btn" aria-label="Open sessions" @click="navOpen = true">☰</button>
        <p>No session selected.</p>
        <button type="button" class="awb-btn awb-btn--primary" @click="creating = true">Start a new session</button>
      </div>
    </main>

    <NewSessionDialog
      v-model:open="creating"
      :agents="state.agents"
      :default-cwd="defaultCwd"
      :cwd-suggestions="recentDirs"
      @create="create"
    />
  </div>
</template>

<style>
html,
body {
  margin: 0;
  height: 100%;
  background: var(--awb-bg);
  color: var(--awb-text);
  font-family: var(--awb-font);
}

#__nuxt {
  height: 100%;
}

.layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  height: 100dvh;
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--awb-border);
  background: var(--awb-bg-subtle);
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 16px 4px;
}
.brand__name {
  font-weight: 700;
}
.brand__tag {
  padding: 1px 6px;
  border: 1px solid var(--awb-border);
  border-radius: 4px;
  color: var(--awb-text-muted);
  font-size: 11px;
}

.sidebar__list {
  flex: 1;
}
.sidebar__foot.is-offline {
  color: var(--awb-warning);
}
.sidebar__foot {
  margin: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--awb-border);
  color: var(--awb-text-muted);
  font-size: 11px;
}

.main {
  position: relative;
  min-height: 0;
}

.error {
  position: absolute;
  top: 72px;
  left: 50%;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 32px);
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--awb-danger);
  color: #fff;
  font-size: 13px;
  transform: translateX(-50%);
}
.error button {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--awb-text-muted);
}

.menu-btn,
.backdrop {
  display: none;
}

@media (max-width: 768px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 20;
    width: min(320px, 85vw);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .nav-open .sidebar {
    transform: none;
  }
  .nav-open .backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgb(0 0 0 / 0.35);
  }
  .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--awb-border);
    border-radius: 8px;
    background: var(--awb-bg);
    color: var(--awb-text);
    font-size: 16px;
  }
  .placeholder .menu-btn {
    position: absolute;
    top: 12px;
    left: 12px;
  }
}
</style>
