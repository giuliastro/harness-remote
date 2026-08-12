import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ATTACHMENT_MAX_EDGE, attachmentPart, attachmentTargetSize } from './attachments.ts'

// A phone camera photo is several times larger than any model needs, and every extra pixel
// is paid for twice: once on a mobile uplink, once in tokens.
assert.deepEqual(
  attachmentTargetSize(4032, 3024),
  { width: ATTACHMENT_MAX_EDGE, height: 1176 },
  'a landscape photo must clamp its longest edge and keep its aspect ratio'
)

assert.deepEqual(
  attachmentTargetSize(3024, 4032),
  { width: 1176, height: ATTACHMENT_MAX_EDGE },
  'a portrait photo must clamp the other axis'
)

assert.deepEqual(
  attachmentTargetSize(800, 600),
  { width: 800, height: 600 },
  'an image already below the ceiling must not be upscaled'
)

assert.deepEqual(
  attachmentTargetSize(ATTACHMENT_MAX_EDGE, ATTACHMENT_MAX_EDGE),
  { width: ATTACHMENT_MAX_EDGE, height: ATTACHMENT_MAX_EDGE },
  'an image exactly at the ceiling must pass through untouched'
)

const scaled = attachmentTargetSize(1569, 1000)
assert.ok(Number.isInteger(scaled.width) && Number.isInteger(scaled.height), 'pixel dimensions must be integers')

// The bridge reads `mime`, `filename` and a base64 data URL; anything else it rejects.
assert.deepEqual(
  attachmentPart('image/jpeg', 'erro.jpg', 'data:image/jpeg;base64,AAAA'),
  { type: 'file', mime: 'image/jpeg', filename: 'erro.jpg', url: 'data:image/jpeg;base64,AAAA' },
  'a part must carry exactly what the bridge validates'
)

assert.throws(
  () => attachmentPart('image/jpeg', 'erro.jpg', 'https://example.com/erro.jpg'),
  /data URL/,
  'a remote URL must be refused: the bridge cannot fetch it'
)

// Composer wiring, in the source-assertion style the other web regressions use. The picker and the
// part-building live in the extracted composer; the staged list and the transcript stay with the
// coordinator state in `App.tsx`, so each assertion has to read the module that now owns it.
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const composerView = readFileSync(new URL('./components/session-composer.tsx', import.meta.url), 'utf8')
assert.ok(composerView.includes('accept="image/*"'), 'the composer must offer an image picker')
assert.ok(composerView.includes('fileToAttachment('), 'the composer must build parts through the shared helper')
assert.ok(
  app.includes('setAttachments([])'),
  'sending must clear the staged attachments so the next prompt does not resend them'
)

// Without this the image vanishes from the conversation the moment it is sent: the composer chip
// is cleared and nothing in the transcript draws the part the bridge replays.
assert.ok(app.includes('part.type === "file"'), 'the transcript must render an attached image')
assert.ok(app.includes('message-attachment'), 'an attached image needs its own transcript style')

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
assert.match(styles, /\.message-attachment\s*\{[^}]*max-width:/, 'a thumbnail must be bounded so a photo cannot widen the page')

// The bridge refuses attachments a harness never advertised. Offering the control anyway means the
// only way to discover that is a failed send, which is the confusing path this gate removes. The
// gate spans two modules now, and losing either half re-opens the control: `App.tsx` reads the
// reported capability into the prop, the composer renders nothing without it.
assert.ok(
  app.includes('supportsAttachments={capabilities.attachments}'),
  'the composer must be handed the attachment capability the bridge reports'
)
assert.ok(
  composerView.includes('supportsAttachments && <>'),
  'the attachment control must be gated on the capability the bridge reports'
)
const defaults = readFileSync(new URL('./backendCapabilities.ts', import.meta.url), 'utf8')
assert.equal(
  (defaults.match(/attachments:/g) ?? []).length,
  5,
  'every backend default must state its attachment support, so a failed capability fetch cannot enable the control by omission'
)

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
assert.ok(
  api.includes('...attachments'),
  'sendPrompt must append the attachment parts after the text part'
)

console.log('attachment tests passed')
