<script setup lang="ts">
import type { ChatMessage } from '@agent-web-bridge/protocol'
import { ref } from 'vue'
import { imageDataUrl } from '../images'
import { formatBytes } from '../utils'
import MarkdownText from './MarkdownText.vue'
import ToolCallCard from './ToolCallCard.vue'

defineProps<{ message: ChatMessage }>()

const zoomed = ref<number>()
</script>

<template>
  <div v-if="message.kind === 'user'" class="awb-msg awb-msg--user">
    <div class="awb-msg__bubble">
      <div v-if="message.images?.length" class="awb-msg__images">
        <button
          v-for="(image, index) in message.images"
          :key="index"
          type="button"
          class="awb-msg__image"
          :class="{ 'is-zoomed': zoomed === index }"
          @click="zoomed = zoomed === index ? undefined : index"
        >
          <img :src="imageDataUrl(image)" alt="Attached image" />
        </button>
      </div>
      <ul v-if="message.files?.length" class="awb-msg__files">
        <li v-for="file in message.files" :key="file.id" :title="file.name">
          <span class="awb-msg__file-name">{{ file.name }}</span>
          <span class="awb-msg__file-size">{{ formatBytes(file.size) }}</span>
        </li>
      </ul>
      <template v-if="message.text">{{ message.text }}</template>
    </div>
  </div>
  <MarkdownText v-else-if="message.kind === 'assistant'" class="awb-msg awb-msg--assistant" :source="message.text" />
  <details v-else-if="message.kind === 'thinking'" class="awb-msg awb-msg--thinking">
    <summary>Thinking</summary>
    <MarkdownText :source="message.text" />
  </details>
  <ToolCallCard v-else-if="message.kind === 'tool'" :message="message" />
  <div v-else class="awb-msg awb-msg--system" :data-level="message.level ?? 'info'">{{ message.text }}</div>
</template>
