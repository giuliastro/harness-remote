/**
 * Image attachments for prompts.
 *
 * The bridge accepts `file` parts carrying a base64 data URL and forwards them to the
 * harness as ACP image blocks. Resizing happens here rather than on the bridge because a
 * phone photo is several megabytes of pixels no model needs: shrinking before upload saves
 * the mobile uplink and the tokens both.
 *
 * The geometry and the part shape are pure so they can be tested without a DOM; only
 * `fileToAttachment` touches the canvas.
 */

export const ATTACHMENT_MAX_EDGE = 1568
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_MAX_COUNT = 8

export type AttachmentPart = {
  type: "file"
  mime: string
  filename: string
  url: string
}

/** Clamps the longest edge, keeps the aspect ratio, and never upscales. */
export function attachmentTargetSize(width: number, height: number, maxEdge = ATTACHMENT_MAX_EDGE) {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

export function attachmentPart(mime: string, filename: string, url: string): AttachmentPart {
  if (!url.startsWith("data:")) throw new Error("An attachment must be a base64 data URL")
  return { type: "file", mime, filename, url }
}

/**
 * Everything goes through the canvas, which also normalises whatever the picker returns —
 * HEIC from a phone camera, or an animated GIF — into a format the bridge accepts. Flattening
 * an animation loses nothing here: an ACP image block carries a single frame either way.
 *
 * A PNG that needed no resizing is re-encoded as PNG, which is lossless, so screenshots stay
 * crisp and their text stays readable. Anything resized is a photo-sized image where JPEG is
 * the right trade, and a PNG that lands above the ceiling falls back to JPEG rather than
 * being refused by the bridge.
 */
export async function fileToAttachment(
  file: File,
  maxEdge = ATTACHMENT_MAX_EDGE,
  maxBytes = ATTACHMENT_MAX_BYTES
): Promise<AttachmentPart> {
  const filename = file.name || "attachment"
  const bitmap = await createImageBitmap(file)
  const target = attachmentTargetSize(bitmap.width, bitmap.height, maxEdge)
  const canvas = document.createElement("canvas")
  canvas.width = target.width
  canvas.height = target.height
  const context = canvas.getContext("2d")
  if (!context) {
    bitmap.close()
    throw new Error("This browser cannot resize the image")
  }
  context.drawImage(bitmap, 0, 0, target.width, target.height)
  const resized = target.width !== bitmap.width || target.height !== bitmap.height
  bitmap.close()

  if (file.type === "image/png" && !resized) {
    const lossless = canvas.toDataURL("image/png")
    // A data URL carries 4 characters per 3 bytes, so compare in the encoded domain.
    if (lossless.length <= Math.floor(maxBytes / 3) * 4) return attachmentPart("image/png", filename, lossless)
  }
  return attachmentPart("image/jpeg", filename, canvas.toDataURL("image/jpeg", 0.85))
}
