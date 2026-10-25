import type { ChatMessage, PermissionResponse } from '@agent-web-bridge/protocol'
import type { InjectionKey } from 'vue'

/** Provided by MessageList to the (possibly nested) messages it renders. */
export interface MessageContext {
  /** Messages nested in a tool call, e.g. a subagent's transcript. */
  childrenOf(toolId: string): ChatMessage[]
  respond(requestId: string, response: PermissionResponse): void
}

export const messageContextKey: InjectionKey<MessageContext> = Symbol('awb-message-context')
