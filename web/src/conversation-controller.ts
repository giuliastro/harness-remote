import { api } from "./api"
import { taskClient } from "./taskClient"

/**
 * Explicit I/O boundary used by the mature conversation UI.
 *
 * Task-backed conversations use the default controller below. Native Sessions provide a Session-
 * scoped implementation instead of mutating api/taskClient methods globally at runtime. Keeping
 * this boundary explicit makes the effective call graph visible to humans, tests and coding agents.
 */
export type ConversationController = {
  loadMessagePage: typeof api.loadMessagePage
  getWorkThread: typeof taskClient.getWorkThread
  continueTask: typeof taskClient.continueTask
  cancelWorkThread: typeof taskClient.cancelWorkThread
}

export const taskConversationController: ConversationController = {
  loadMessagePage: (...args) => api.loadMessagePage(...args),
  getWorkThread: (...args) => taskClient.getWorkThread(...args),
  continueTask: (...args) => taskClient.continueTask(...args),
  cancelWorkThread: (...args) => taskClient.cancelWorkThread(...args)
}
