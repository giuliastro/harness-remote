import { useEffect, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { copyToClipboard } from "../clipboard"
import { CheckIcon, CopyIcon } from "../Icons"

export const REMARK_PLUGINS = [remarkGfm]

/** Reads the source text back out of a rendered subtree, so a copy carries what the agent wrote
 *  rather than what Markdown turned it into. Walking the hast node avoids reaching into React
 *  children, which by this point are elements and no longer strings. */
export function hastText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const element = node as { type?: string; value?: string; children?: unknown[] }
  if (element.type === "text") return element.value ?? ""
  if (!Array.isArray(element.children)) return ""
  return element.children.map(hastText).join("")
}

/**
 * `clipboard.ts` was written for this app's plain-http LAN case, where `navigator.clipboard` is
 * absent rather than merely refused, and until now only the retired 2.x shell used it: 3.0 shipped
 * with no way to copy anything out of a conversation at all. Every reference chat client offers this
 * on both code blocks and whole messages, and for an agent that answers with commands and patches it
 * is the most common thing to want from a reply.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // An empty copy would silently replace whatever the user already had on the clipboard.
  if (!text.trim()) return null

  return (
    <button
      type="button"
      className={`uw-copy-button${copied ? " copied" : ""}`}
      // The label carries the state because the icon alone does not: a checkmark is not text.
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void copyToClipboard(text)
        setCopied(true)
      }}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  )
}

/** Stable identity: rebuilding this per render would remount every code block on every token. */
export const MARKDOWN_COMPONENTS: Components = {
  pre({ node, children, ...rest }) {
    return (
      <div className="uw-code-block">
        <CopyButton text={hastText(node)} label="Copy code" />
        <pre {...rest}>{children}</pre>
      </div>
    )
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="uw-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
}
