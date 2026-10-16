import { encode } from "uqr"

/**
 * Client-side rendering of the machine pairing QR.
 *
 * The daemon hands the client only the one-time URI; how it becomes pixels is a presentation
 * concern that belongs to the app that shows it. Keeping it here means the web, desktop and
 * Android clients all render the same code from the same library, and the module stays free of
 * React so a plain Node test can build a matrix and decode it back with a real QR reader.
 */
export type PairingQRCode = {
  /** Width and height in modules, quiet zone included. */
  size: number
  /** `true` for dark modules, rows first. */
  modules: boolean[][]
  /** SVG path drawing every dark module in a `0 0 size size` viewBox. */
  path: string
}

// The QR spec asks for a four-module quiet zone; many camera readers tolerate less, none do worse
// with more. Four also keeps the code scannable when the dialog's own padding touches the SVG.
const QUIET_ZONE_MODULES = 4
// A pairing URI is roughly 120-170 characters. M tolerates 15% loss, which is enough for a phone
// scanning a screen at an angle while keeping the module count small enough to stay crisp.
const DEFAULT_ECC = "M"

export function pairingQRPath(modules: boolean[][]): string {
  const commands: string[] = []
  for (let y = 0; y < modules.length; y += 1) {
    const row = modules[y] ?? []
    for (let x = 0; x < row.length; x += 1) {
      if (row[x]) commands.push(`M${x} ${y}h1v1h-1Z`)
    }
  }
  return commands.join("")
}

export function pairingQRCode(uri: string, options: { border?: number; ecc?: "L" | "M" | "Q" | "H" } = {}): PairingQRCode | null {
  if (typeof uri !== "string" || !uri) return null
  try {
    const { size, data } = encode(uri, {
      border: options.border ?? QUIET_ZONE_MODULES,
      ecc: options.ecc ?? DEFAULT_ECC
    })
    return { size, modules: data, path: pairingQRPath(data) }
  } catch {
    return null
  }
}
