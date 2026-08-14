import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_JOB !== 'apk' && process.env.HARNESS_REMOTE_ENABLE_TASKS !== '1') process.exit(0)

const file = fileURLToPath(new URL('../src/components/session-list.tsx', import.meta.url))
const source = readFileSync(file, 'utf8')
const marker = 'const TASK_LAUNCH_ENABLED = false'
if (!source.includes(marker)) throw new Error('TASK_LAUNCH_ENABLED marker not found')
writeFileSync(file, source.replace(marker, 'const TASK_LAUNCH_ENABLED = true'))
console.log('New Task enabled for disposable integration APK')
