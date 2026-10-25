<script setup lang="ts">
import type { ChatMessage, PermissionResponse, ToolMessage } from '@agent-web-bridge/protocol'
import { computed, inject, ref, watch } from 'vue'
import { messageContextKey } from '../context'
import { toolSummary } from '../utils'
import MarkdownText from './MarkdownText.vue'
import MessageItem from './MessageItem.vue'
import QuestionForm from './QuestionForm.vue'

const props = defineProps<{ message: ToolMessage }>()

const ICONS = { pending: '○', running: '◌', success: '✓', error: '✕', denied: '⊘' }

const context = inject(messageContextKey, undefined)
const children = computed(() => context?.childrenOf(props.message.id) ?? [])
const awaitingPermission = computed(() => props.message.permission?.status === 'pending')
const questions = computed(() => (awaitingPermission.value ? props.message.permission?.questions : undefined))
const answers = computed(() => Object.entries(props.message.permission?.answers ?? {}))
const plan = computed(() => {
  const input = props.message.input as { plan?: unknown } | undefined
  return props.message.name === 'ExitPlanMode' && typeof input?.plan === 'string' ? input.plan : undefined
})
const summary = computed(() => toolSummary(props.message.input))
const input = computed(() => JSON.stringify(props.message.input, null, 2))

/** True when this card or anything nested in it waits for the user. */
function needsUser(message: ChatMessage): boolean {
  if (message.kind !== 'tool') return false
  return message.permission?.status === 'pending' || (context?.childrenOf(message.id).some(needsUser) ?? false)
}
const attention = computed(() => needsUser(props.message))
const open = ref(attention.value)
// Show the full input (or the nested request) when the agent asks for something.
watch(attention, (value) => value && (open.value = true))

function respond(response: PermissionResponse) {
  if (props.message.permission) context?.respond(props.message.permission.id, response)
}
</script>

<template>
  <div class="awb-tool" :data-status="message.status" :class="{ 'is-awaiting': awaitingPermission }">
    <button type="button" class="awb-tool__head" :aria-expanded="open" @click="open = !open">
      <span class="awb-tool__icon">{{ ICONS[message.status] }}</span>
      <span class="awb-tool__name">{{ message.name }}</span>
      <code class="awb-tool__summary">{{ summary }}</code>
      <span v-if="children.length" class="awb-tool__count">{{ children.length }}</span>
      <span class="awb-tool__chevron">›</span>
    </button>
    <div v-if="open" class="awb-tool__body">
      <MarkdownText v-if="plan" class="awb-tool__plan" :source="plan" />
      <dl v-else-if="answers.length" class="awb-tool__answers">
        <template v-for="[question, answer] in answers" :key="question">
          <dt>{{ question }}</dt>
          <dd>{{ answer }}</dd>
        </template>
      </dl>
      <pre v-else-if="!questions" class="awb-pre">{{ input }}</pre>
      <div v-if="children.length" class="awb-tool__children">
        <MessageItem v-for="child in children" :key="child.id" :message="child" />
      </div>
      <pre v-if="message.output" class="awb-pre awb-tool__output">{{ message.output }}</pre>
    </div>
    <div v-if="questions" class="awb-tool__permission awb-tool__permission--question">
      <QuestionForm
        :questions="questions"
        @submit="(answers) => respond({ decision: 'allow', answers })"
        @skip="respond({ decision: 'deny' })"
      />
    </div>
    <div v-else-if="awaitingPermission" class="awb-tool__permission">
      <span v-if="message.permission?.title">{{ message.permission.title }}</span>
      <span v-else>Allow <strong>{{ message.name }}</strong>?</span>
      <div class="awb-tool__actions">
        <button type="button" class="awb-btn awb-btn--primary awb-btn--sm" @click="respond({ decision: 'allow' })">Allow</button>
        <button
          v-if="message.permission?.canAlwaysAllow"
          type="button"
          class="awb-btn awb-btn--sm"
          @click="respond({ decision: 'allow_always' })"
        >
          Always allow
        </button>
        <button type="button" class="awb-btn awb-btn--danger awb-btn--sm" @click="respond({ decision: 'deny' })">Deny</button>
      </div>
    </div>
  </div>
</template>
