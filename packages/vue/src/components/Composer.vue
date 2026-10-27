<script setup lang="ts">
import type { AgentInfo, FileAttachment, ImageAttachment } from '@agent-web-bridge/protocol'
import { computed, ref, useTemplateRef } from 'vue'
import { imageDataUrl, isInlineImage, readImage } from '../images'
import { formatBytes } from '../utils'

const props = defineProps<{
  agent?: AgentInfo
  busy?: boolean
  suspended?: boolean
  disabled?: boolean
  /** Uploads a non-image file (e.g. `client.upload`); files can be attached only when it is given. */
  upload?: (file: File, signal: AbortSignal) => Promise<FileAttachment>
}>()
const emit = defineEmits<{ send: [text: string, images: ImageAttachment[], files: FileAttachment[]]; interrupt: [] }>()
const model = defineModel<string>('model')
const permissionMode = defineModel<string>('permissionMode')
const effort = defineModel<string>('effort')

const text = ref('')
const images = ref<ImageAttachment[]>([])
/** Files being uploaded (`uploaded` unset) or uploaded. */
const files = ref<{ name: string; size: number; uploaded?: FileAttachment; abort: AbortController }[]>([])
const attachError = ref<string>()
const dragging = ref(false)
const fileInput = useTemplateRef('fileInput')

const canAttachImages = computed(() => !!props.agent?.supportsImages)
const canAttachFiles = computed(() => !!props.agent?.supportsFiles && !!props.upload)
const canAttach = computed(() => canAttachImages.value || canAttachFiles.value)
const uploading = computed(() => files.value.some((f) => !f.uploaded))
const canSend = computed(
  () => !props.disabled && !uploading.value && (!!text.value.trim() || images.value.length > 0 || files.value.length > 0),
)
const placeholder = computed(() => {
  if (props.suspended) return 'Send a message to resume this session'
  if (props.busy) return 'Agent is working — your message will be queued'
  return 'Message the agent (Enter to send, Shift+Enter for newline)'
})

function submit() {
  if (!canSend.value) return
  emit('send', text.value.trim(), images.value, files.value.map((f) => f.uploaded!))
  text.value = ''
  images.value = []
  files.value = []
}

function onKeydown(event: KeyboardEvent) {
  // isComposing: Enter that confirms an IME composition (Korean, Japanese, ...) must not send.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

/** Images go inline with the message; other files (and images the agent cannot take inline) are uploaded. */
function accepts(file: File): boolean {
  return canAttachFiles.value || (canAttachImages.value && isInlineImage(file))
}

async function addFiles(list: Iterable<File>) {
  if (!canAttach.value) return
  attachError.value = undefined
  for (const file of list) {
    if (!accepts(file)) {
      attachError.value = `Cannot attach ${file.name}: only images are accepted`
    } else if (canAttachImages.value && isInlineImage(file)) {
      try {
        images.value.push(await readImage(file))
      } catch (error) {
        attachError.value = errorText(error)
      }
    } else {
      void uploadFile(file)
    }
  }
}

async function uploadFile(file: File) {
  const entry = { name: file.name, size: file.size, uploaded: undefined as FileAttachment | undefined, abort: new AbortController() }
  files.value.push(entry)
  try {
    const uploaded = await props.upload!(file, entry.abort.signal)
    // Look the entry up again: it may have been removed meanwhile, and the stored one is the reactive proxy.
    const current = files.value.find((f) => f.abort === entry.abort)
    if (current) current.uploaded = uploaded
  } catch (error) {
    if (entry.abort.signal.aborted) return
    files.value = files.value.filter((f) => f.abort !== entry.abort)
    attachError.value = `${file.name}: ${errorText(error)}`
  }
}

function removeFile(index: number) {
  const [removed] = files.value.splice(index, 1)
  removed?.abort.abort()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function onPaste(event: ClipboardEvent) {
  const pasted = [...(event.clipboardData?.files ?? [])]
  if (pasted.some(accepts)) {
    event.preventDefault()
    void addFiles(pasted)
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
      <div v-if="images.length || files.length || attachError" class="awb-composer__attachments">
        <div v-for="(image, index) in images" :key="index" class="awb-composer__thumb">
          <img :src="imageDataUrl(image)" alt="Attachment" />
          <button type="button" aria-label="Remove image" @click="images.splice(index, 1)">✕</button>
        </div>
        <div
          v-for="(file, index) in files"
          :key="`file-${index}`"
          class="awb-composer__file"
          :class="{ 'is-uploading': !file.uploaded }"
          :title="file.name"
        >
          <span class="awb-composer__file-name">{{ file.name }}</span>
          <span class="awb-composer__file-size">{{ file.uploaded ? formatBytes(file.size) : 'Uploading…' }}</span>
          <button type="button" aria-label="Remove file" @click="removeFile(index)">✕</button>
        </div>
        <span v-if="attachError" class="awb-composer__error">{{ attachError }}</span>
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
        <button
          type="button"
          class="awb-btn awb-btn--icon"
          :aria-label="canAttachFiles ? 'Attach files' : 'Attach images'"
          :title="canAttachFiles ? 'Attach files' : 'Attach images'"
          @click="fileInput?.click()"
        >
          +
        </button>
        <input
          ref="fileInput"
          type="file"
          :accept="canAttachFiles ? undefined : 'image/png,image/jpeg,image/gif,image/webp'"
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
      <label v-if="agent?.efforts.length" class="awb-composer__select">
        <span>Effort</span>
        <select v-model="effort" :disabled="disabled">
          <option v-for="option in agent.efforts" :key="option.id" :value="option.id">{{ option.label }}</option>
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
