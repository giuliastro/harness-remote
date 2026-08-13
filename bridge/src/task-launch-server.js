export function taskLaunchPath(pathname) {
  return /^\/v1\/tasks\/([^/]+)\/launch$/.exec(pathname)
}
