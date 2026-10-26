<script setup lang="ts">
import type { AgentInfo, CreateSessionRequest } from '@agent-web-bridge/protocol'
import { computed, onMounted, reactive, useId, useTemplateRef, watch } from 'vue'

const props = defineProps<{ agents: AgentInfo[]; defaultCwd?: string; cwdSuggestions?: string[] }>()
const emit = defineEmits<{ create: [request: CreateSessionRequest] }>()
const open = defineModel<boolean>('open', { default: false })

const dialog = useTemplateRef('dialog')
const listId = useId()
const form = reactive({ agentId: '', cwd: '', model: '', permissionMode: '', effort: '', prompt: '' })
const agent = computed(() => props.agents.find((a) => a.id === form.agentId))

function applyAgentDefaults() {
  form.model = agent.value?.defaultModel ?? agent.value?.models[0]?.id ?? ''
  form.permissionMode = agent.value?.defaultPermissionMode ?? agent.value?.permissionModes[0]?.id ?? ''
  form.effort = agent.value?.defaultEffort ?? agent.value?.efforts[0]?.id ?? ''
}

function sync() {
  if (!dialog.value) return
  if (open.value && !dialog.value.open) {
    Object.assign(form, { agentId: props.agents[0]?.id ?? '', cwd: props.defaultCwd ?? '', prompt: '' })
    applyAgentDefaults()
    dialog.value.showModal()
  } else if (!open.value && dialog.value.open) {
    dialog.value.close()
  }
}

onMounted(sync)
watch(open, sync, { flush: 'post' })
watch(() => form.agentId, applyAgentDefaults)

function submit() {
  emit('create', {
    agentId: form.agentId,
    cwd: form.cwd.trim(),
    model: form.model || undefined,
    permissionMode: form.permissionMode || undefined,
    effort: form.effort || undefined,
    prompt: form.prompt.trim() || undefined,
  })
  open.value = false
}
</script>

<template>
  <dialog ref="dialog" class="awb-dialog" @close="open = false">
    <form class="awb-dialog__form" @submit.prevent="submit">
      <h2 class="awb-dialog__title">New session</h2>
      <label class="awb-field">
        <span>Agent</span>
        <select v-model="form.agentId" required>
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label class="awb-field">
        <span>Working directory</span>
        <input v-model="form.cwd" required :list="listId" placeholder="/path/to/project" />
        <datalist :id="listId">
          <option v-for="dir in cwdSuggestions" :key="dir" :value="dir" />
        </datalist>
      </label>
      <div class="awb-field-row">
        <label v-if="agent?.models.length" class="awb-field">
          <span>Model</span>
          <select v-model="form.model">
            <option v-for="m in agent.models" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
        <label v-if="agent?.permissionModes.length" class="awb-field">
          <span>Permission mode</span>
          <select v-model="form.permissionMode">
            <option v-for="m in agent.permissionModes" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
        <label v-if="agent?.efforts.length" class="awb-field">
          <span>Effort</span>
          <select v-model="form.effort">
            <option v-for="m in agent.efforts" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
      </div>
      <label class="awb-field">
        <span>First message <em>(optional)</em></span>
        <textarea v-model="form.prompt" rows="3" placeholder="What should the agent do?" />
      </label>
      <div class="awb-dialog__actions">
        <button type="button" class="awb-btn" @click="open = false">Cancel</button>
        <button type="submit" class="awb-btn awb-btn--primary">Create</button>
      </div>
    </form>
  </dialog>
</template>
