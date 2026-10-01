/**
 * Formats one `console.*` call into a single line of JSON for Cloud Logging.
 *
 * Why this exists: on App Hosting/Cloud Run, Node's `console.error('[tag]', {obj})`
 * pretty-prints an object across multiple lines, and Cloud Run's log agent reads
 * stdout/stderr LINE BY LINE — so the tag line, every field, and the closing `}`
 * each become their own log entry, all with severity DEFAULT (verified on alpha).
 * `action` tags become impossible to correlate, severity filters and Error
 * Reporting see nothing, and log-based alerts need hand-written single-line
 * strings (see #337 / lib/accountDeletionAlert.ts).
 *
 * Cloud Run's log agent parses a single-line JSON object on stdout/stderr into
 * `jsonPayload`, using a few special top-level keys: `severity`, `message`,
 * `logging.googleapis.com/*`, and (for Error Reporting) `stack_trace`. If
 * `message` is the only non-special field left, Cloud Logging stores the
 * entry as `textPayload` instead (still with `severity`) — so a plain-string
 * log lands in `textPayload`, and only logs with object fields land in
 * `jsonPayload` (verified on alpha). This formatter builds that shape,
 * deterministically, so it stays testable without needing Cloud Run itself.
 *
 * MUST NEVER THROW — a formatting bug must not take down logging, let alone
 * the request. Every risky step is wrapped. Critically, the LAST-RESORT
 * fallback (when even the normal path's own try/catch fails) never touches
 * anything argument-derived (no `String(arg)`, no property access) — a
 * poisoned argument (throwing getter, throwing `toString`/`Symbol.toPrimitive`)
 * must not be able to make even the fallback throw.
 */

/** Cloud Logging's hard cap is 256 KB per entry; stay comfortably under it. */
const MAX_LINE_BYTES = 200_000
/** Long strings (e.g. stack traces, HTML bodies) get truncated to this length. */
const MAX_STRING_LENGTH = 4_000
/** Object/array nesting beyond this depth collapses to a marker string. */
const MAX_DEPTH = 5
/**
 * How many `.cause`/`.errors` hops of an Error chain we'll follow before
 * stopping. This is ONE shared budget for both: a `.cause` chain and an
 * AggregateError's `.errors` each consume from the same `depth` counter in
 * `serializeError`, they don't get independent allowances.
 */
const MAX_ERROR_CAUSE_DEPTH = 3

/**
 * Cloud Logging keys that carry entry metadata — a logged field must never
 * be able to clobber these, at any nesting depth. `logging.googleapis.com/*`
 * is matched by prefix since it's a namespace, not a fixed list of keys.
 *
 * `error` and `args` are handled separately (see the collision check in
 * `buildEntry` below) — unlike these, they're only reserved conditionally: `{ error: err }`
 * as the WHOLE argument (`console.error('[tag]', { error: err })`, an
 * existing, common pattern in this codebase) is exactly how a nested Error
 * is meant to reach `entry.error`. Only a genuine COLLISION — a direct Error
 * argument AND an object field both wanting the `error` key, or a bare array
 * argument AND an object field both wanting `args` — needs renaming, and only
 * `buildEntry` (which sees the whole argument list) can tell those apart.
 */
const RESERVED_KEYS = new Set(['severity', 'message', 'stack_trace'])
const RESERVED_KEY_PREFIX = 'logging.googleapis.com/'

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key) || key.startsWith(RESERVED_KEY_PREFIX)
}

/** Reserved keys are prefixed so a logged field can never clobber entry metadata. */
function prefixReservedKey(key: string): string {
  return isReservedKey(key) ? `field_${key}` : key
}

/** Strips ANSI escape sequences (e.g. Next's own logger prefixes picocolors codes — see node_modules/next/dist/build/output/log.js). */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '')
}

const LEVEL_TO_SEVERITY = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  log: 'INFO',
  debug: 'DEBUG',
} as const

export type ConsoleLevel = keyof typeof LEVEL_TO_SEVERITY

/** Shape of a serialized `Error` — mirrors what Error Reporting expects. */
interface SerializedError {
  name: string
  message: string
  code?: string
  stack?: string
  cause?: unknown
  errors?: unknown[]
}

function serializeError(err: Error, depth = 0): SerializedError {
  const out: SerializedError = { name: err.name, message: err.message }
  // Firebase/Node errors commonly carry a `.code` (e.g. 'auth/invalid-token').
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') out.code = code
  if (typeof err.stack === 'string') out.stack = truncateString(err.stack)

  // `.cause` (ES2022) and AggregateError's `.errors` can themselves be Errors
  // (or arbitrarily deep chains of them) — follow a bounded number of hops so
  // a pathological or circular cause chain can't recurse forever.
  if (depth < MAX_ERROR_CAUSE_DEPTH) {
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) {
      out.cause = cause instanceof Error ? serializeError(cause, depth + 1) : sanitize(cause, depth + 1, new Set())
    }

    const errors = (err as { errors?: unknown }).errors
    if (Array.isArray(errors)) {
      out.errors = errors.map((e) =>
        e instanceof Error ? serializeError(e, depth + 1) : sanitize(e, depth + 1, new Set()),
      )
    }
  }

  return out
}

/** Truncates a string by character count (used for individual field/stack values). */
function truncateString(s: string): string {
  if (s.length <= MAX_STRING_LENGTH) return s
  return s.slice(0, MAX_STRING_LENGTH) + `…[truncated ${s.length - MAX_STRING_LENGTH} chars]`
}

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte character (and therefore never emitting a lone UTF-16 surrogate
 * half either). `TextDecoder` with `fatal: false` replaces any incomplete
 * trailing byte sequence with a single U+FFFD instead of a broken half-character.
 */
function truncateUtf8Bytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes)
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

/**
 * Deep-clones a value into something JSON-safe: caps depth, truncates long
 * strings, stringifies BigInt, drops functions/symbols, marks circular
 * references, and gives well-known non-plain-object types (Date, RegExp,
 * Map, Set, Buffer/typed arrays) an explicit, useful representation instead
 * of silently collapsing to `{}` via `Object.entries`.
 */
function sanitize(value: unknown, depth: number, seen: Set<unknown>): unknown {
  if (depth > MAX_DEPTH) return '[MaxDepth]'

  if (value === null || value === undefined) return value ?? null

  const t = typeof value
  if (t === 'string') return truncateString(value as string)
  if (t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return (value as bigint).toString()
  if (t === 'function' || t === 'symbol') return undefined

  if (value instanceof Error) return serializeError(value)

  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? 'Invalid Date' : value.toISOString()
  }

  if (value instanceof RegExp) return String(value)

  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = Array.from(value.entries()).map(([k, v]) => [
      sanitize(k, depth + 1, seen),
      sanitize(v, depth + 1, seen),
    ])
    seen.delete(value)
    return out
  }

  if (value instanceof Set) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = Array.from(value).map((item) => sanitize(item, depth + 1, seen))
    seen.delete(value)
    return out
  }

  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) {
    const byteLength = (value as { byteLength?: number }).byteLength ?? 0
    return `[${value.constructor?.name ?? 'TypedArray'} ${byteLength} bytes]`
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = value.map((item) => sanitize(item, depth + 1, seen))
    seen.delete(value)
    return out
  }

  if (t === 'object') {
    // A custom `toJSON` (Firestore Timestamps, Dates already handled above,
    // many SDK types) expresses the author's own intended serialization —
    // prefer it, but never trust it not to throw.
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
      try {
        return sanitize((toJSON as () => unknown).call(value), depth + 1, seen)
      } catch {
        // Fall through to plain enumerable-property serialization below.
      }
    }

    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[prefixReservedKey(key)] = sanitize(v, depth + 1, seen)
    }
    seen.delete(value)
    return out
  }

  // Any other object kind (Promise, WeakMap, a class instance with no
  // enumerable own properties and no toJSON, …) has nothing more specific to
  // extract — it serializes via the generic object branch above, typically
  // to `{}`.
  return value
}

/** True for the primitive kinds that get joined into `message` rather than becoming fields. */
function isPrimitiveArg(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
}

/** Formats one primitive arg for the `message` string: stringify, strip ANSI, cap length. */
function formatMessagePart(v: string | number | boolean | null | undefined): string {
  return truncateString(stripAnsi(String(v)))
}

/**
 * Builds the Cloud Logging entry (pre-JSON.stringify) for one console call.
 * Exported separately from `formatLogEntry` so tests can inspect structure
 * without re-parsing a JSON string.
 */
function buildEntry(level: ConsoleLevel, args: unknown[]): Record<string, unknown> {
  const entry: Record<string, unknown> = { severity: LEVEL_TO_SEVERITY[level] }

  const messageParts: string[] = []
  let directErrorStack: string | undefined

  // A direct Error/Array argument claims the top-level `error`/`args` key —
  // only THEN does an object field of the same name need renaming, so this
  // has to be known up front regardless of each argument's position.
  const hasDirectError = args.some((a) => a instanceof Error)
  const hasBareArray = args.some((a) => Array.isArray(a))

  for (const arg of args) {
    if (isPrimitiveArg(arg)) {
      messageParts.push(formatMessagePart(arg))
      continue
    }

    if (Array.isArray(arg)) {
      // A bare array argument doesn't have field names of its own — keep it
      // together under `args` rather than spreading indices as top-level keys.
      const existing = entry.args
      const sanitizedArr = sanitize(arg, 1, new Set())
      entry.args = Array.isArray(existing) ? [...existing, sanitizedArr] : [sanitizedArr]
      continue
    }

    if (arg instanceof Error) {
      const serialized = serializeError(arg)
      entry.error = serialized
      // Error Reporting keys off `stack_trace` on the entry itself, and
      // treats `message` as the human-readable summary — so a directly
      // logged Error contributes both.
      directErrorStack = arg.stack
      messageParts.push(formatMessagePart(arg.message))
      continue
    }

    if (arg !== null && typeof arg === 'object') {
      const sanitized = sanitize(arg, 1, new Set()) as Record<string, unknown>
      for (const [key, value] of Object.entries(sanitized)) {
        const collides =
          (key === 'error' && hasDirectError) || (key === 'args' && hasBareArray)
        entry[collides ? `field_${key}` : key] = value
      }
      continue
    }

    // Fallback for anything else unexpected (shouldn't normally happen).
    messageParts.push(formatMessagePart(String(arg)))
  }

  if (messageParts.length > 0) {
    entry.message = messageParts.join(' ')
  } else {
    // No string/number/boolean arg was logged (e.g. `console.error({action, uid})`
    // or a bare Error we already turned into `entry.error`/messageParts above).
    // Give `message` SOMETHING useful rather than an empty string, since an
    // empty message is unsearchable and looks broken in Cloud Logging.
    const actionField = entry.action
    const errorField = entry.error as SerializedError | undefined
    if (typeof actionField === 'string' && actionField.length > 0) {
      entry.message = actionField
    } else if (errorField && typeof errorField.message === 'string') {
      entry.message = errorField.message
    } else {
      entry.message = '(no message)'
    }
  }

  if (directErrorStack) entry.stack_trace = truncateString(directErrorStack)

  return entry
}

/** Builds the minimal, guaranteed-under-cap fallback entry for an oversized log line. */
function buildOversizeFallback(level: ConsoleLevel, rawMessage: string): string {
  // JSON-escaping (quotes, backslashes, control chars) can expand a string's
  // byte size unpredictably, so shrink-and-recheck rather than trust a single
  // byte budget computed from the raw string.
  let budget = MAX_LINE_BYTES - 128
  for (let attempt = 0; attempt < 8 && budget > 0; attempt++) {
    const truncated = truncateUtf8Bytes(rawMessage, budget) || '[log entry too large, fields dropped]'
    const candidate = JSON.stringify({
      severity: LEVEL_TO_SEVERITY[level],
      message: truncated,
      field_truncated: true,
    })
    if (Buffer.byteLength(candidate, 'utf8') <= MAX_LINE_BYTES) return candidate
    budget = Math.floor(budget / 2)
  }
  // Last resort: a fixed, tiny, always-safe literal.
  return JSON.stringify({ severity: LEVEL_TO_SEVERITY[level], message: '[log entry too large]', field_truncated: true })
}

/**
 * Formats a `console.*` call into a single line of JSON, ready to hand to
 * the console (see lib/installStructuredConsole.ts for why it's handed to
 * the console rather than written to a stream directly). Never throws.
 *
 * Two layers of safety:
 * 1. The normal path is wrapped in try/catch — a poisoned argument (throwing
 *    getter, circular structure JSON.stringify chokes on, etc.) falls back
 *    to a minimal entry.
 * 2. That fallback itself is wrapped again, and — critically — never
 *    touches the original `args` (no `String(args)`, no property access on
 *    them). Only `args.length`, a plain number, is used. This is what makes
 *    the fallback safe even when the argument's own `toString`/
 *    `Symbol.toPrimitive`/getters throw.
 */
export function formatLogEntry(level: ConsoleLevel, args: unknown[]): string {
  try {
    const entry = buildEntry(level, args)
    const line = JSON.stringify(entry)
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return buildOversizeFallback(level, (entry.message as string) ?? '')
    }
    return line
  } catch {
    try {
      const severity = LEVEL_TO_SEVERITY[level] ?? 'DEFAULT'
      return JSON.stringify({
        severity,
        message: `[log formatting failed for ${args.length} argument(s)]`,
      })
    } catch {
      // JSON.stringify on a hand-built plain object with string values
      // should never throw, but if the environment is broken enough that it
      // does, fall back to a static string literal — no computation at all.
      return '{"severity":"ERROR","message":"[unserializable log arguments]"}'
    }
  }
}
