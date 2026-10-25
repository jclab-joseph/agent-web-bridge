<script setup lang="ts">
import type { SessionStatus } from '@agent-web-bridge/protocol'
import { STATUS_LABELS } from '../utils'

defineProps<{ status: SessionStatus }>()
</script>

<template>
  <span class="awb-status" :data-status="status">
    <span class="awb-status__dot" />
    {{ STATUS_LABELS[status] }}
  </span>
</template>
