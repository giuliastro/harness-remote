// Harness adapters write their diagnostics to stderr because stdout carries the protocol, so a
// stderr line says nothing about its severity. Claude's adapter, for example, traces every
// session replay there and reports each SDK event it does not recognise yet as "Unexpected case".
// Forwarding all of it made a release daemon's terminal read like a debug build. By default only
// lines that look like a failure reach the terminal; --verbose restores the full stream.

// No leading boundary on error/exception so class names such as TypeError still count.
const ERROR_PATTERN = /(errors?|exception)\b|\b(fatal|failed|failure|panic|traceback|uncaught|unhandled|denied)\b/i
// Node system error codes such as ENOENT or EADDRINUSE, which are case-sensitive by convention.
const ERROR_CODE_PATTERN = /\bE[A-Z]{3,}\b/

// The adapter's catch-all for message variants newer than itself. The event is skipped and the
// session carries on, so it is protocol drift rather than a failure even though it is logged as
// one - and its JSON payload can contain words that would otherwise look like an error.
const UNRECOGNISED_EVENT_PATTERN = /^Unexpected case:/

export function isHarnessErrorLine(line) {
  const text = String(line).trim()
  if (!text || UNRECOGNISED_EVENT_PATTERN.test(text)) return false
  return ERROR_PATTERN.test(text) || ERROR_CODE_PATTERN.test(text)
}

export function createHarnessLogWriter({ verbose = false, write = (text) => process.stderr.write(text) } = {}) {
  return (prefix, line) => {
    if (verbose || isHarnessErrorLine(line)) write(`[${prefix}] ${line}\n`)
  }
}
