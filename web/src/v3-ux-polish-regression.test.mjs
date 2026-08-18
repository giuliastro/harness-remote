import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => fs.readFileSync(path.join(here, name), "utf8")
const readRoot = (name) => fs.readFileSync(path.join(here, "..", "..", name), "utf8")

const backendSetup = read("backendSetup.ts")
const profiles = read("serverProfiles.ts")
const main = read("main.tsx")
const polish = read("v3-polish.css")
const readme = readRoot("README.md")

assert.match(backendSetup, /return 4097/)
assert.doesNotMatch(backendSetup, /opencode-ai serve/)
assert.match(backendSetup, /npx github:giuliastro\/harness-remote/)
assert.doesNotMatch(backendSetup, /--backend \$\{backend\}/)
assert.match(backendSetup, /return "harness"/)

assert.match(profiles, /port: 4097/)
assert.match(profiles, /username: "harness"/)

assert.match(main, /target\.querySelector\("#new-session-title"\)/)
assert.match(main, /event\.stopImmediatePropagation\(\)/)
assert.match(main, /document\.querySelector\("\.settings"\)/)
assert.match(main, /import "\.\/v3-polish\.css"/)

assert.match(polish, /server-switcher-menu/)
assert.match(polish, /position: sticky/)
assert.match(polish, /path-breadcrumb > span:first-child \+ span/)

assert.match(readme, /public port is \*\*4097\*\*/)
assert.match(readme, /loopback port \*\*4096\*\*/)
assert.match(readme, /one launcher per machine/)
assert.doesNotMatch(readme, /does \*\*not yet serve every detected ACP backend simultaneously\*\*/)

console.log("v3 UX polish regressions passed")
