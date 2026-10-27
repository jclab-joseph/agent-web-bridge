<script setup lang="ts">
import type {
  AgentInfo,
  ChatMessage,
  FileAttachment,
  ImageAttachment,
  PermissionResponse,
  SessionInfo,
} from '@agent-web-bridge/protocol'
import { computed } from 'vue'
import Composer from './Composer.vue'
import MessageList from './MessageList.vue'
import SessionHeader from './SessionHeader.vue'

const props = defineProps<{
  session: SessionInfo
  messages: ChatMessage[]
  agent?: AgentInfo
  /** Uploads a file to this session (e.g. `(file, signal) => client.upload(session.id, file, { signal })`); enables file attachments. */
  upload?: (file: File, signal: AbortSignal) => Promise<FileAttachment>
}>()
const emit = defineEmits<{
  send: [text: string, images: ImageAttachment[], files: FileAttachment[]]
  interrupt: []
  permission: [requestId: string, response: PermissionResponse]
  update: [options: { model?: string; permissionMode?: string; effort?: string }]
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
      :effort="session.effort"
      :upload="upload"
      @update:model="(model) => emit('update', { model })"
      @update:permission-mode="(permissionMode) => emit('update', { permissionMode })"
      @update:effort="(effort) => emit('update', { effort })"
      @send="(text, images, files) => emit('send', text, images, files)"
      @interrupt="emit('interrupt')"
    />
  </section>
</template>
