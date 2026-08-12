import type { RefObject } from "react"
import { ATTACHMENT_MAX_COUNT, fileToAttachment, type AttachmentPart } from "../attachments"
import { CloseIcon, PaperclipIcon, SendIcon, StopCircleIcon } from "../Icons"
import type { Translator } from "../i18n"

/** The conversation input has a deliberately narrow interface: it owns input and attachment
 * presentation, while session state and network operations stay with the coordinator. */
export function SessionComposer({
  selected,
  value,
  attachments,
  supportsAttachments,
  showStopAction,
  softKeyboard,
  t,
  composerRef,
  inputRef,
  attachmentInputRef,
  onValueChange,
  onAttachmentsChange,
  onAttachmentError,
  onFocus,
  onSend,
  onAbort
}: {
  selected: boolean
  value: string
  attachments: AttachmentPart[]
  supportsAttachments: boolean
  showStopAction: boolean
  softKeyboard: boolean
  t: Translator
  composerRef: RefObject<HTMLDivElement>
  inputRef: RefObject<HTMLTextAreaElement>
  attachmentInputRef: RefObject<HTMLInputElement>
  onValueChange: (value: string) => void
  onAttachmentsChange: (next: AttachmentPart[] | ((current: AttachmentPart[]) => AttachmentPart[])) => void
  onAttachmentError: (message: string) => void
  onFocus: () => void
  onSend: () => void
  onAbort: () => void
}) {
  return (
    <div className="composer" ref={composerRef}>
      {attachments.length > 0 && <div className="composer-chips">
        {attachments.map((attachment, index) => <span className="composer-chip" key={`${attachment.filename}-${index}`}>
          <strong>{attachment.filename}</strong>
          <button className="btn-ghost btn-icon" aria-label={t('detail.removeAttachment')} onClick={() => onAttachmentsChange((current) => current.filter((_, position) => position !== index))}>
            <CloseIcon size={12} />
          </button>
        </span>)}
      </div>}
      <textarea
        ref={inputRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={t('detail.composerPlaceholder')}
        enterKeyHint={softKeyboard ? "enter" : "send"}
        autoCapitalize="sentences"
        autoCorrect="on"
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          if (softKeyboard) {
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); onSend() }
            return
          }
          if (!event.shiftKey) { event.preventDefault(); onSend() }
        }}
        disabled={!selected}
      />
      <div className="composer-bar">
        {supportsAttachments && <>
          <input ref={attachmentInputRef} type="file" accept="image/*" multiple hidden onChange={async (event) => {
            const chosen = Array.from(event.target.files ?? []).slice(0, ATTACHMENT_MAX_COUNT - attachments.length)
            event.target.value = ""
            if (!chosen.length) return
            try {
              const prepared = await Promise.all(chosen.map((file) => fileToAttachment(file)))
              onAttachmentsChange((current) => [...current, ...prepared])
            } catch (err) {
              onAttachmentError((err as Error).message)
            }
          }} />
          <button className="btn-ghost btn-icon" title={t('detail.attachImage')} aria-label={t('detail.attachImage')} onClick={() => attachmentInputRef.current?.click()} disabled={!selected || attachments.length >= ATTACHMENT_MAX_COUNT}>
            <PaperclipIcon size={18} />
          </button>
        </>}
        <div className="composer-actions"><button onClick={showStopAction ? onAbort : onSend} disabled={!selected} className={showStopAction ? "btn-danger composer-send" : "btn-primary composer-send"}>{showStopAction ? <StopCircleIcon size={18} /> : <SendIcon size={18} />}</button></div>
      </div>
    </div>
  )
}
