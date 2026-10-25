<script setup lang="ts">
import type { AgentInfo, ImageAttachment } from '@agent-web-bridge/protocol'
import { computed, ref, useTemplateRef } from 'vue'
import { imageDataUrl, readImage } from '../images'

const props = defineProps<{ agent?: AgentInfo; busy?: boolean; suspended?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string, images: ImageAttachment[]]; interrupt: [] }>()
const model = defineModel<string>('model')
const permissionMode = defineModel<string>('permissionMode')

const text = ref('')
const images = ref<ImageAttachment[]>([])
const imageError = ref<string>()
const dragging = ref(false)
const fileInput = useTemplateRef('fileInput')

const canAttach = computed(() => !!props.agent?.supportsImages)
const canSend = computed(() => !props.disabled && (!!text.value.trim() || images.value.length > 0))
const placeholder = computed(() => {
  if (props.suspended) return 'Send a message to resume this session'
  if (props.busy) return 'Agent is working — your message will be queued'
  return 'Message the agent (Enter to send, Shift+Enter for newline)'
})

function submit() {
  if (!canSend.value) return
  emit('send', text.value.trim(), images.value)
  text.value = ''
  images.value = []
}

function onKeydown(event: KeyboardEvent) {
  // isComposing: Enter that confirms an IME composition (Korean, Japanese, ...) must not send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

async function addFiles(files: Iterable<File>) {
  if (!canAttach.value) return
  imageError.value = undefined
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    try {
      images.value.push(await readImage(file))
    } catch (error) {
      imageError.value = error instanceof Error ? error.message : String(error)
    }
  }
}

function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])]
  if (canAttach.value && files.some((f) => f.type.startsWith('image/'))) {
    event.preventDefault()
    void addFiles(files)
  }
}

function onDrop(event: DragEvent) {
  dragging.value = false
  if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files)
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) void addFiles(input.files)
  input.value = ''
}
</script>

<template>
  <form
    class="awb-composer"
    :class="{ 'is-dragging': dragging }"
    @submit.prevent="submit"
    @dragover.prevent="dragging = canAttach"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="awb-composer__box">
      <div v-if="images.length || imageError" class="awb-composer__attachments">
        <div v-for="(image, index) in images" :key="index" class="awb-composer__thumb">
          <img :src="imageDataUrl(image)" alt="Attachment" />
          <button type="button" aria-label="Remove image" @click="images.splice(index, 1)">✕</button>
        </div>
        <span v-if="imageError" class="awb-composer__error">{{ imageError }}</span>
      </div>
      <textarea
        v-model="text"
        class="awb-composer__input"
        rows="2"
        :placeholder="placeholder"
        :disabled="disabled"
        @keydown="onKeydown"
        @paste="onPaste"
      />
    </div>
    <div class="awb-composer__bar">
      <template v-if="canAttach">
        <button type="button" class="awb-btn awb-btn--icon" aria-label="Attach images" title="Attach images" @click="fileInput?.click()">
          +
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          @change="onPick"
        />
      </template>
      <label v-if="agent?.permissionModes.length" class="awb-composer__select">
        <span>Mode</span>
        <select v-model="permissionMode" :disabled="disabled">
          <option v-for="mode in agent.permissionModes" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
        </select>
      </label>
      <label v-if="agent?.models.length" class="awb-composer__select">
        <span>Model</span>
        <select v-model="model" :disabled="disabled">
          <option v-for="option in agent.models" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>
      <span class="awb-composer__spacer" />
      <button v-if="busy" type="button" class="awb-btn" @click="emit('interrupt')">Stop</button>
      <button type="submit" class="awb-btn awb-btn--primary" :disabled="!canSend">
        {{ suspended ? 'Resume & send' : 'Send' }}
      </button>
    </div>
  </form>
</template>
