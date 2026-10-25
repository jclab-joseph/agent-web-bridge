<script setup lang="ts">
import type { ChatMessage, PermissionResponse, SessionStatus } from '@agent-web-bridge/protocol'
import { computed, nextTick, onMounted, onUpdated, provide, useTemplateRef } from 'vue'
import { messageContextKey } from '../context'
import MessageItem from './MessageItem.vue'

const props = defineProps<{ messages: ChatMessage[]; status: SessionStatus }>()
const emit = defineEmits<{ permission: [requestId: string, response: PermissionResponse] }>()

const topLevel = computed(() => props.messages.filter((m) => !m.parentId))
const children = computed(() => {
  const byParent = new Map<string, ChatMessage[]>()
  for (const message of props.messages) {
    if (!message.parentId) continue
    const list = byParent.get(message.parentId)
    if (list) list.push(message)
    else byParent.set(message.parentId, [message])
  }
  return byParent
})

provide(messageContextKey, {
  childrenOf: (toolId) => children.value.get(toolId) ?? [],
  respond: (requestId, response) => emit('permission', requestId, response),
})

const scroller = useTemplateRef('scroller')
/** Follow new output only while the user is at the bottom, so reading earlier messages is not interrupted. */
let pinned = true

function onScroll() {
  const el = scroller.value
  if (el) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function follow() {
  if (pinned) nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }))
}

onMounted(follow)
onUpdated(follow)
</script>

<template>
  <div ref="scroller" class="awb-messages" @scroll.passive="onScroll">
    <div class="awb-messages__inner">
      <MessageItem v-for="message in topLevel" :key="message.id" :message="message" />
      <div v-if="status === 'busy' || status === 'starting'" class="awb-typing"><span /><span /><span /></div>
      <p v-if="status === 'suspended'" class="awb-notice">
        This session was suspended after being idle. Send a message to resume it.
      </p>
      <p v-if="!messages.length && status === 'idle'" class="awb-empty">Send a message to start.</p>
    </div>
  </div>
</template>
