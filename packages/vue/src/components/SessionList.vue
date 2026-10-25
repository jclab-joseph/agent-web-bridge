<script setup lang="ts">
import type { SessionInfo } from '@agent-web-bridge/protocol'
import { computed } from 'vue'
import { useNow } from '../composables/useNow'
import { formatDuration, formatRelative, shortPath } from '../utils'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ sessions: SessionInfo[]; activeId?: string }>()
const emit = defineEmits<{ select: [id: string]; create: [] }>()

const now = useNow()
const sorted = computed(() => [...props.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt))

function meta(session: SessionInfo) {
  if (session.expiresAt) {
    return `suspends in ${formatDuration(session.expiresAt - now.value)}`
  }
  return formatRelative(session.lastActiveAt, now.value)
}
</script>

<template>
  <nav class="awb-session-list">
    <div class="awb-session-list__header">
      <span>Sessions</span>
      <button type="button" class="awb-btn awb-btn--primary awb-btn--sm" @click="emit('create')">+ New</button>
    </div>
    <ul v-if="sorted.length" class="awb-session-list__items">
      <li v-for="session in sorted" :key="session.id">
        <button
          type="button"
          class="awb-session-item"
          :class="{ 'is-active': session.id === activeId }"
          @click="emit('select', session.id)"
        >
          <span class="awb-session-item__title">{{ session.title }}</span>
          <span class="awb-session-item__cwd">{{ shortPath(session.cwd) }}</span>
          <span class="awb-session-item__meta">
            <StatusBadge :status="session.status" />
            <span>{{ meta(session) }}</span>
          </span>
        </button>
      </li>
    </ul>
    <p v-else class="awb-empty">No sessions yet.</p>
  </nav>
</template>
