<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../markdown'

const props = defineProps<{ source: string }>()
const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- Safe: renderMarkdown escapes raw HTML. -->
  <div class="awb-md" v-html="html" />
</template>
