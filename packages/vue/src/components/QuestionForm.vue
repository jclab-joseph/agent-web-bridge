<script setup lang="ts">
import type { Question } from '@agent-web-bridge/protocol'
import { computed, ref, useId } from 'vue'
import MarkdownText from './MarkdownText.vue'

const props = defineProps<{ questions: Question[] }>()
const emit = defineEmits<{ submit: [answers: Record<string, string>]; skip: [] }>()

const uid = useId()
const selected = ref<string[][]>(props.questions.map(() => []))
const other = ref<string[]>(props.questions.map(() => ''))

const complete = computed(() => props.questions.every((_, i) => selected.value[i]!.length || other.value[i]!.trim()))

function toggle(index: number, label: string) {
  const question = props.questions[index]!
  const current = selected.value[index]!
  if (question.multiSelect) {
    selected.value[index] = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
  } else {
    selected.value[index] = [label]
    other.value[index] = ''
  }
}

function onOther(index: number) {
  // A typed answer replaces the choice of a single-select question.
  if (!props.questions[index]!.multiSelect && other.value[index]!.trim()) selected.value[index] = []
}

function preview(index: number) {
  const question = props.questions[index]!
  if (question.multiSelect) return undefined
  return question.options.find((o) => o.label === selected.value[index]![0])?.preview
}

function submit() {
  const answers: Record<string, string> = {}
  props.questions.forEach((question, i) => {
    const typed = other.value[i]!.trim()
    answers[question.question] = [...selected.value[i]!, ...(typed ? [typed] : [])].join(', ')
  })
  emit('submit', answers)
}
</script>

<template>
  <form class="awb-question" @submit.prevent="submit">
    <fieldset v-for="(question, qi) in questions" :key="qi" class="awb-question__item">
      <legend class="awb-question__title">
        <span v-if="question.header" class="awb-chip">{{ question.header }}</span>
        {{ question.question }}
      </legend>
      <div class="awb-question__options">
        <label
          v-for="option in question.options"
          :key="option.label"
          class="awb-option"
          :class="{ 'is-selected': selected[qi]!.includes(option.label) }"
        >
          <input
            :type="question.multiSelect ? 'checkbox' : 'radio'"
            :name="`${uid}-${qi}`"
            :checked="selected[qi]!.includes(option.label)"
            @change="toggle(qi, option.label)"
          />
          <span class="awb-option__label">{{ option.label }}</span>
          <span v-if="option.description" class="awb-option__desc">{{ option.description }}</span>
        </label>
      </div>
      <MarkdownText v-if="preview(qi)" class="awb-question__preview" :source="preview(qi)!" />
      <input v-model="other[qi]" class="awb-question__other" placeholder="Other answer…" @input="onOther(qi)" />
    </fieldset>
    <div class="awb-question__actions">
      <button type="button" class="awb-btn awb-btn--sm" @click="emit('skip')">Skip</button>
      <button type="submit" class="awb-btn awb-btn--primary awb-btn--sm" :disabled="!complete">Answer</button>
    </div>
  </form>
</template>
