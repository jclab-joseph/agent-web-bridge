<script setup lang="ts">
import type { AgentInfo, ChatMessage, ImageAttachment, PermissionResponse, SessionInfo } from '@agent-web-bridge/protocol'
import { computed } from 'vue'
import Composer from './Composer.vue'
import MessageList from './MessageList.vue'
import SessionHeader from './SessionHeader.vue'

const props = defineProps<{ session: SessionInfo; messages: ChatMessage[]; agent?: AgentInfo }>()
const emit = defineEmits<{
  send: [text: string, images: ImageAttachment[]]
  interrupt: []
  permission: [requestId: string, response: PermissionResponse]
  update: [options: { model?: string; permissionMode?: string }]
  suspend: []
  delete: []
}>()

const busy = computed(() => ['busy', 'awaiting_permission'].includes(props.session.status))
</script>

<template>
  <section class="awb-chat">
    <SessionHeader
      :session="session"
      :agent="agent"
      @suspend="emit('suspend')"
      @delete="emit('delete')"
    >
      <template #leading><slot name="header-leading" /></template>
      <template #actions><slot name="header-actions" /></template>
    </SessionHeader>
    <MessageList
      :messages="messages"
      :status="session.status"
      @permission="(requestId, response) => emit('permission', requestId, response)"
    />
    <Composer
      :agent="agent"
      :busy="busy"
      :suspended="session.status === 'suspended'"
      :disabled="session.status === 'starting'"
      :model="session.model"
      :permission-mode="session.permissionMode"
      @update:model="(model) => emit('update', { model })"
      @update:permission-mode="(permissionMode) => emit('update', { permissionMode })"
      @send="(text, images) => emit('send', text, images)"
      @interrupt="emit('interrupt')"
    />
  </section>
</template>
