<script setup lang="ts">
import type { AgentInfo, SessionInfo } from '@agent-web-bridge/protocol'
import { computed } from 'vue'
import { useNow } from '../composables/useNow'
import { formatDuration, shortPath } from '../utils'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ session: SessionInfo; agent?: AgentInfo }>()
const emit = defineEmits<{ suspend: []; delete: [] }>()

const now = useNow()
const alive = computed(() => ['idle', 'busy', 'awaiting_permission'].includes(props.session.status))
const ttl = computed(() => {
  const { status, expiresAt } = props.session
  if (expiresAt) return `Suspends in ${formatDuration(expiresAt - now.value)}`
  if (status === 'suspended') return 'Resumes on next message'
  return undefined
})
</script>

<template>
  <header class="awb-header">
    <slot name="leading" />
    <div class="awb-header__info">
      <h2 class="awb-header__title">{{ session.title }}</h2>
      <p class="awb-header__sub">
        <span class="awb-chip">{{ agent?.name ?? session.agentId }}</span>
        <span class="awb-header__cwd">{{ shortPath(session.cwd) }}</span>
      </p>
    </div>
    <div class="awb-header__state">
      <StatusBadge :status="session.status" />
      <span v-if="ttl" class="awb-header__ttl">{{ ttl }}</span>
    </div>
    <div class="awb-header__actions">
      <slot name="actions" />
      <button v-if="alive" type="button" class="awb-btn awb-btn--sm" @click="emit('suspend')">Suspend</button>
      <button type="button" class="awb-btn awb-btn--sm awb-btn--danger" @click="emit('delete')">Delete</button>
    </div>
  </header>
</template>
