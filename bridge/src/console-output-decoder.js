import { execFileSync } from "node:child_process"

/**
 * Upper halves (bytes 0x80-0xFF) of the DOS code pages Windows uses as the console "OEM" code page
 * in Western and Central European locales. Node's ICU `TextDecoder` only knows the WHATWG
 * encodings, which leave these out, so cmd.exe's own messages need a table of their own.
 */
const OEM_UPPER_HALVES = {
  437: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
  850: "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ",
  852: "ÇüéâäůćçłëŐőîŹÄĆÉĹĺôöĽľŚśÖÜŤťŁ×čáíóúĄąŽžĘę¬źČş«»░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐└┴┬├─┼Ăă╚╔╩╦╠═╬¤đĐĎËďŇÍÎě┘┌█▄ŢŮ▀ÓßÔŃńňŠšŔÚŕŰýÝţ´­˝˛ˇ˘§÷¸°¨˙űŘř■ "
}
// 858 is 850 with the euro sign where 850 has the dotless i.
OEM_UPPER_HALVES[858] = `${OEM_UPPER_HALVES[850].slice(0, 0x55)}€${OEM_UPPER_HALVES[850].slice(0x56)}`

/** OEM code pages that the WHATWG encodings already cover, by the label `TextDecoder` accepts. */
const OEM_TEXT_DECODER_LABELS = {
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5"
}

const utf8 = new TextDecoder("utf-8", { fatal: true })
const utf8Lenient = new TextDecoder("utf-8")
let cachedOemCodePage

/**
 * The console code page cmd.exe writes its own messages in. A console started without `chcp`
 * uses the system OEM code page, which the registry records; reading it costs a `reg` call, so it
 * happens once and only when a line has turned out not to be UTF-8.
 */
export function systemOemCodePage() {
  if (cachedOemCodePage !== undefined) return cachedOemCodePage
  cachedOemCodePage = null
  if (process.platform !== "win32") return cachedOemCodePage
  try {
    const output = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"], {
      encoding: "latin1",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"]
    })
    const match = /OEMCP\s+REG_SZ\s+(\d+)/i.exec(output)
    if (match) cachedOemCodePage = Number(match[1])
  } catch {
    // Without the code page, the line falls back to UTF-8 with replacement characters, as before.
  }
  return cachedOemCodePage
}

/** Decodes bytes in the given OEM code page, or returns undefined when it is not one we know. */
export function oemDecoder(codePage) {
  const upperHalf = OEM_UPPER_HALVES[codePage]
  if (upperHalf) {
    return (bytes) => {
      let text = ""
      for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : upperHalf[byte - 0x80]
      return text
    }
  }
  const label = OEM_TEXT_DECODER_LABELS[codePage]
  if (!label) return undefined
  const decoder = new TextDecoder(label)
  return (bytes) => decoder.decode(bytes)
}

/**
 * Turns the stderr of a process run through cmd.exe into text.
 *
 * Two writers share that stream: the adapter, which (being Node or another modern runtime) writes
 * UTF-8, and cmd.exe itself, which writes "... non è riconosciuto come comando interno ..." in the
 * console OEM code page. Each line is decoded as UTF-8 when it is valid UTF-8 and in the OEM code
 * page otherwise. Splitting at LF is safe for both: no multibyte UTF-8 sequence and no DBCS trail
 * byte is 0x0A.
 */
export class ConsoleOutputDecoder {
  #pending = Buffer.alloc(0)
  #codePage
  #fallback

  /** @param {{ codePage?: number | (() => number | null | undefined) }} [options] */
  constructor({ codePage = systemOemCodePage } = {}) {
    this.#codePage = codePage
  }

  /** Returns the text of every line the chunk completes; an unfinished line waits for the next. */
  write(chunk) {
    const bytes = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : Buffer.from(chunk)
    const end = bytes.lastIndexOf(0x0a) + 1
    this.#pending = bytes.subarray(end)
    return end ? this.#decodeLines(bytes.subarray(0, end)) : ""
  }

  /** Returns whatever is left once the stream has ended. */
  end() {
    const rest = this.#pending
    this.#pending = Buffer.alloc(0)
    return rest.length ? this.#decodeLines(rest) : ""
  }

  #decodeLines(bytes) {
    let text = ""
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start)
      const stop = newline < 0 ? bytes.length : newline + 1
      text += this.#decodeLine(bytes.subarray(start, stop))
      start = stop
    }
    return text
  }

  #decodeLine(line) {
    try {
      return utf8.decode(line)
    } catch {
      const fallback = this.#resolveFallback()
      return fallback ? fallback(line) : utf8Lenient.decode(line)
    }
  }

  #resolveFallback() {
    if (this.#fallback === undefined) {
      const codePage = typeof this.#codePage === "function" ? this.#codePage() : this.#codePage
      this.#fallback = (Number.isInteger(codePage) && oemDecoder(codePage)) || null
    }
    return this.#fallback
  }
}
