import { api } from "./api"
import type { AttachmentPart } from "./attachments"
import { conversationRuntimeFromTask, type ConversationRuntime } from "./conversation-runtime"
import { taskClient } from "./taskClient"
import type { ModelSelection } from "./types"

export type ConversationContinueInput = {
  prompt: string
  agentId?: string
  model?: ModelSelection | null
  attachments?: AttachmentPart[]
  command?: { name: string; arguments: string }
}

/**
 * Explicit I/O boundary used by the mature conversation UI.
 *
 * The UI speaks only in ConversationRuntime terms. Legacy Task-backed consumers are adapted here;
 * Native Sessions implement this contract directly and are never projected into MachineTask/Run.
 */
export type ConversationController = {
  loadMessagePage: typeof api.loadMessagePage
  refreshConversation: (config: Parameters<typeof taskClient.getWorkThread>[0], conversationId: string) => Promise<ConversationRuntime>
  continueConversation: (config: Parameters<typeof taskClient.continueTask>[0], conversationId: string, input: ConversationContinueInput) => Promise<ConversationRuntime>
  stopConversation: (config: Parameters<typeof taskClient.cancelWorkThread>[0], conversationId: string) => Promise<ConversationRuntime>
}

export const taskConversationController: ConversationController = {
  loadMessagePage: (...args) => api.loadMessagePage(...args),
  refreshConversation: async (...args) => conversationRuntimeFromTask(await taskClient.getWorkThread(...args)),
  continueConversation: async (config, conversationId, input) =>
    conversationRuntimeFromTask(await taskClient.continueTask(config, conversationId, input)),
  stopConversation: async (...args) => conversationRuntimeFromTask(await taskClient.cancelWorkThread(...args))
}
