import type { SessionStatus } from '@agent-web-bridge/protocol'

export const STATUS_LABELS: Record<SessionStatus, string> = {
  starting: 'Starting',
  idle: 'Idle',
  busy: 'Working',
  awaiting_permission: 'Needs approval',
  suspended: 'Suspended',
  error: 'Error',
}

export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, '~')
}

/** Formats a duration as m:ss. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatRelative(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / (60 * 24))}d ago`
}

/** One-line description of a tool call, taken from the most telling input field. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'plan']) {
    const value = fields[key]
    if (typeof value === 'string') return value
  }
  const [first] = Array.isArray(fields.questions) ? fields.questions : []
  return typeof first?.question === 'string' ? first.question : ''
}
