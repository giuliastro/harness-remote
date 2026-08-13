export class TaskLaunchError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = "TaskLaunchError"
    this.code = code
  }
}

export function taskLaunchError(code, message, options) {
  return new TaskLaunchError(code, message, options)
}
