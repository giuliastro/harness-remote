import assert from "node:assert/strict"
import test from "node:test"
import {
  WORKSPACE_ATTACHMENT_MAX_BYTES,
  isWorkspaceAttachmentFile,
  workspaceAttachmentPayload
} from "./attachments.ts"

test("recognizes the spreadsheet file types accepted by the workspace upload", () => {
  assert.equal(isWorkspaceAttachmentFile({ name: "data.csv" }), true)
  assert.equal(isWorkspaceAttachmentFile({ name: "DATA.XLSX" }), true)
  assert.equal(isWorkspaceAttachmentFile({ name: "legacy.xls" }), true)
  assert.equal(isWorkspaceAttachmentFile({ name: "notes.txt" }), false)
  assert.equal(isWorkspaceAttachmentFile({ name: "image.png" }), false)
})

test("turns a CSV into the base64 payload the bridge stores", async () => {
  const file = new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" })
  const payload = await workspaceAttachmentPayload(file)
  assert.equal(payload.filename, "data.csv")
  assert.equal(payload.mime, "text/csv")
  assert.equal(Buffer.from(payload.data, "base64").toString("utf8"), "a,b\n1,2\n")
})

test("rejects unsupported and oversized workspace files before upload", async () => {
  await assert.rejects(
    workspaceAttachmentPayload(new File(["x"], "notes.txt", { type: "text/plain" })),
    /CSV, XLSX and XLS/
  )
  const oversized = new File([new Uint8Array(WORKSPACE_ATTACHMENT_MAX_BYTES + 1)], "big.xlsx")
  await assert.rejects(workspaceAttachmentPayload(oversized), /under 10MB/)
})
