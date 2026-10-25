import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

/** Current time, refreshed every `intervalMs` while the component is mounted. */
export function useNow(intervalMs = 1000) {
  const now = shallowRef(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    timer = setInterval(() => (now.value = Date.now()), intervalMs)
  })
  onBeforeUnmount(() => clearInterval(timer))
  return now
}
