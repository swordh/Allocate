/**
 * `formatLogEntry` is the piece that turns one `console.*` call into a
 * single line of Cloud-Logging-shaped JSON (see lib/structuredLog.ts's own
 * docblock for why this exists — multi-line console output gets split into
 * several unstructured log entries on App Hosting/Cloud Run).
 *
 * These tests lock: severity mapping, message join rules (including the
 * empty-message fallback and ANSI stripping), reserved-key prefixing
 * (including the app-level `error`/`args` keys this formatter itself sets),
 * Error serialization (direct arg, nested in a field, `.cause` chains,
 * AggregateError's `.errors`), explicit handling of Date/RegExp/Map/Set/
 * Buffer/typed-array/toJSON values, and every safety cap (circular refs,
 * depth, per-string length, byte-accurate line size with multi-byte content)
 * — plus that formatting can NEVER throw, even when an argument's own
 * getter and `toString` both throw, and always yields valid single-line
 * JSON no larger than the line cap.
 */

import { describe, it, expect } from 'vitest'
import { formatLogEntry } from '@/lib/structuredLog'

function parse(line: string): Record<string, unknown> {
  // A single call to JSON.parse also proves there's no embedded newline —
  // JSON.parse tolerates them, so assert explicitly too (see test below).
  return JSON.parse(line)
}

describe('formatLogEntry', () => {
  describe('severity mapping', () => {
    it.each([
      ['error', 'ERROR'],
      ['warn', 'WARNING'],
      ['info', 'INFO'],
      ['log', 'INFO'],
      ['debug', 'DEBUG'],
    ] as const)('%s -> %s', (level, severity) => {
      const entry = parse(formatLogEntry(level, ['hi']))
      expect(entry.severity).toBe(severity)
    })
  })

  describe('message', () => {
    it('joins string/number/boolean/null/undefined args with spaces', () => {
      const entry = parse(formatLogEntry('log', ['a', 1, true, null, undefined, 'b']))
      expect(entry.message).toBe('a 1 true null undefined b')
    })

    it('preserves an alert-marker-style single string arg exactly', () => {
      const marker = '[actions/account] ACCOUNT_DELETION_STUCK path=companies/abc123/deletion'
      const entry = parse(formatLogEntry('error', [marker]))
      expect(entry.message).toBe(marker)
    })

    it('does not include object fields in message', () => {
      const entry = parse(formatLogEntry('info', ['starting', { action: 'sync' }]))
      expect(entry.message).toBe('starting')
      expect(entry.action).toBe('sync')
    })

    it('falls back to the `action` field when there is no primitive arg', () => {
      const entry = parse(formatLogEntry('info', [{ action: 'sync', uid: 'abc123' }]))
      expect(entry.message).toBe('sync')
    })

    it('falls back to the Error message when there is no primitive arg and no action field', () => {
      const entry = parse(formatLogEntry('error', [{ error: new Error('db down') }]))
      expect(entry.message).toBe('db down')
    })

    it('falls back to a fixed placeholder when there is truly nothing to say', () => {
      const entry = parse(formatLogEntry('info', [{ uid: 'abc123' }]))
      expect(entry.message).toBe('(no message)')
    })

    it('strips ANSI escape codes from message parts', () => {
      const dimmed = '\x1b[2m[tag] something happened\x1b[22m'
      const entry = parse(formatLogEntry('log', [dimmed]))
      expect(entry.message).toBe('[tag] something happened')
    })
  })

  describe('object fields', () => {
    it('lifts plain object fields to the top level', () => {
      const entry = parse(formatLogEntry('info', [{ action: 'export', uid: 'abc123' }]))
      expect(entry.action).toBe('export')
      expect(entry.uid).toBe('abc123')
    })

    it('merges fields from multiple object args', () => {
      const entry = parse(formatLogEntry('info', [{ action: 'export' }, { uid: 'abc123' }]))
      expect(entry.action).toBe('export')
      expect(entry.uid).toBe('abc123')
    })

    it('puts a bare array argument under `args`, not spread as fields', () => {
      const entry = parse(formatLogEntry('log', [[1, 2, 3]]))
      expect(entry.args).toEqual([[1, 2, 3]])
      expect(entry['0']).toBeUndefined()
    })
  })

  describe('reserved keys', () => {
    it('prefixes a field named severity/message/stack_trace with field_', () => {
      const entry = parse(
        formatLogEntry('info', [{ severity: 'fake', message: 'fake', stack_trace: 'fake' }]),
      )
      expect(entry.field_severity).toBe('fake')
      expect(entry.field_message).toBe('fake')
      expect(entry.field_stack_trace).toBe('fake')
      // Real entry metadata untouched.
      expect(entry.severity).toBe('INFO')
    })

    it('prefixes a logging.googleapis.com/* field', () => {
      const entry = parse(formatLogEntry('info', [{ 'logging.googleapis.com/trace': 'x' }]))
      expect(entry['field_logging.googleapis.com/trace']).toBe('x')
    })

    it('prefixes a user-supplied `error`/`args` field so it cannot clobber the real one', () => {
      // A real Error arg sets entry.error; a plain object arg with its own
      // `error` key must not be allowed to overwrite it, regardless of order.
      const real = new Error('real')
      const entryA = parse(formatLogEntry('error', [real, { error: 'decoy' }]))
      expect((entryA.error as { message: string }).message).toBe('real')
      expect(entryA.field_error).toBe('decoy')

      const entryB = parse(formatLogEntry('error', [{ error: 'decoy' }, real]))
      expect((entryB.error as { message: string }).message).toBe('real')
      expect(entryB.field_error).toBe('decoy')

      const entryC = parse(formatLogEntry('log', [[1, 2], { args: 'decoy' }]))
      expect(entryC.args).toEqual([[1, 2]])
      expect(entryC.field_args).toBe('decoy')
    })
  })

  describe('Error handling', () => {
    it('serializes a direct Error argument into stack_trace and error, and appends its message', () => {
      const err = new Error('boom')
      const entry = parse(formatLogEntry('error', ['failed', err]))
      expect(entry.message).toBe('failed boom')
      expect(entry.stack_trace).toContain('Error: boom')
      expect(entry.error).toMatchObject({ name: 'Error', message: 'boom' })
    })

    it('serializes an Error nested in a field, including a string .code', () => {
      const err = Object.assign(new Error('nope'), { code: 'auth/invalid-token' })
      const entry = parse(formatLogEntry('error', [{ error: err, action: 'verify' }]))
      expect(entry.action).toBe('verify')
      expect(entry.error).toMatchObject({ name: 'Error', message: 'nope', code: 'auth/invalid-token' })
      expect((entry.error as { stack: string }).stack).toContain('Error: nope')
      // A nested error does not hijack the entry-level stack_trace/message.
      expect(entry.stack_trace).toBeUndefined()
    })

    it('serializes .cause recursively, depth-capped', () => {
      const root = new Error('root cause')
      const mid = new Error('mid', { cause: root })
      const top = new Error('top', { cause: mid })
      const entry = parse(formatLogEntry('error', [top]))
      const errorField = entry.error as { cause: { message: string; cause: { message: string } } }
      expect(errorField.cause.message).toBe('mid')
      expect(errorField.cause.cause.message).toBe('root cause')
    })

    it('stops following a .cause chain at MAX_ERROR_CAUSE_DEPTH instead of walking it all the way', () => {
      // 5 hops deep — one more than the 3-hop budget. If the cap didn't
      // apply, c4's message would appear at .cause.cause.cause.cause.
      const c4 = new Error('c4')
      const c3 = new Error('c3', { cause: c4 })
      const c2 = new Error('c2', { cause: c3 })
      const c1 = new Error('c1', { cause: c2 })
      const top = new Error('top', { cause: c1 })
      const entry = parse(formatLogEntry('error', [top]))
      type Chained = { message: string; cause?: Chained }
      const errorField = entry.error as Chained
      expect(errorField.cause?.message).toBe('c1')
      expect(errorField.cause?.cause?.message).toBe('c2')
      expect(errorField.cause?.cause?.cause?.message).toBe('c3')
      // The budget is exhausted by the time we'd serialize c3's own .cause —
      // c4 must never appear.
      expect(errorField.cause?.cause?.cause?.cause).toBeUndefined()
    })

    it('terminates on a self-referential .cause instead of recursing forever', () => {
      const err: Error & { cause?: unknown } = new Error('circular')
      err.cause = err
      let line = ''
      expect(() => {
        line = formatLogEntry('error', [err])
      }).not.toThrow()
      expect(() => JSON.parse(line)).not.toThrow()
      type Chained = { message: string; cause?: Chained }
      const errorField = JSON.parse(line).error as Chained
      // Same depth budget applies regardless of the cause chain being a
      // cycle: three hops of the same object, then it stops.
      expect(errorField.cause?.message).toBe('circular')
      expect(errorField.cause?.cause?.message).toBe('circular')
      expect(errorField.cause?.cause?.cause?.message).toBe('circular')
      expect(errorField.cause?.cause?.cause?.cause).toBeUndefined()
    })

    it('serializes AggregateError.errors', () => {
      const agg = new AggregateError([new Error('one'), new Error('two')], 'both failed')
      const entry = parse(formatLogEntry('error', [agg]))
      const errorField = entry.error as { errors: Array<{ message: string }> }
      expect(errorField.errors.map((e) => e.message)).toEqual(['one', 'two'])
    })
  })

  describe('well-known object types', () => {
    it('serializes a Date as an ISO string', () => {
      const entry = parse(formatLogEntry('info', [{ at: new Date('2026-09-25T10:00:00.000Z') }]))
      expect(entry.at).toBe('2026-09-25T10:00:00.000Z')
    })

    it('serializes an invalid Date as the string "Invalid Date"', () => {
      const entry = parse(formatLogEntry('info', [{ at: new Date('not a date') }]))
      expect(entry.at).toBe('Invalid Date')
    })

    it('serializes a RegExp via String()', () => {
      const entry = parse(formatLogEntry('info', [{ pattern: /abc+/gi }]))
      expect(entry.pattern).toBe('/abc+/gi')
    })

    it('serializes a Map as sanitized [key, value] pairs', () => {
      const entry = parse(formatLogEntry('info', [{ m: new Map([['a', 1], ['b', 2]]) }]))
      expect(entry.m).toEqual([['a', 1], ['b', 2]])
    })

    it('serializes a Set as a sanitized array', () => {
      const entry = parse(formatLogEntry('info', [{ s: new Set([1, 2, 2, 3]) }]))
      expect(entry.s).toEqual([1, 2, 3])
    })

    it('summarizes a Buffer by length instead of expanding its bytes', () => {
      const entry = parse(formatLogEntry('info', [{ b: Buffer.from('hello world') }]))
      expect(entry.b).toBe('[Buffer 11 bytes]')
    })

    it('summarizes a typed array by byte length', () => {
      const entry = parse(formatLogEntry('info', [{ b: new Uint8Array([1, 2, 3, 4]) }]))
      expect(entry.b).toBe('[Uint8Array 4 bytes]')
    })

    it('calls a custom toJSON and sanitizes its result', () => {
      const withToJSON = { toJSON: () => ({ shape: 'custom' }) }
      const entry = parse(formatLogEntry('info', [{ obj: withToJSON }]))
      expect(entry.obj).toEqual({ shape: 'custom' })
    })

    it('falls back to plain serialization when toJSON throws', () => {
      const poisoned = {
        real: 'field',
        toJSON: () => {
          throw new Error('toJSON boom')
        },
      }
      const entry = parse(formatLogEntry('info', [{ obj: poisoned }]))
      expect(entry.obj).toMatchObject({ real: 'field' })
    })
  })

  describe('circular references', () => {
    it('replaces a circular object reference with [Circular]', () => {
      const obj: Record<string, unknown> = { action: 'loop' }
      obj.self = obj
      const entry = parse(formatLogEntry('info', [obj]))
      expect(entry.self).toBe('[Circular]')
    })

    it('replaces a circular array reference with [Circular]', () => {
      const arr: unknown[] = [1, 2]
      arr.push(arr)
      const entry = parse(formatLogEntry('info', [{ list: arr }]))
      expect((entry.list as unknown[])[2]).toBe('[Circular]')
    })
  })

  describe('caps', () => {
    it('collapses nesting beyond max depth to a marker', () => {
      let deep: Record<string, unknown> = { bottom: true }
      for (let i = 0; i < 10; i++) deep = { nested: deep }
      const entry = parse(formatLogEntry('info', [deep]))
      // Walk down until we hit the marker instead of an object.
      let cursor: unknown = entry.nested
      let hitMarker = false
      for (let i = 0; i < 10; i++) {
        if (cursor === '[MaxDepth]') {
          hitMarker = true
          break
        }
        cursor = (cursor as Record<string, unknown>)?.nested
      }
      expect(hitMarker).toBe(true)
    })

    it('truncates a long string field', () => {
      const long = 'x'.repeat(10_000)
      const entry = parse(formatLogEntry('info', [{ blob: long }]))
      expect((entry.blob as string).length).toBeLessThan(long.length)
      expect(entry.blob as string).toContain('truncated')
    })

    it('falls back to a minimal safe entry when the built entry would exceed the line cap', () => {
      // Build something that survives per-string truncation (many distinct
      // keys, each under the per-string cap) but is still huge overall.
      const huge: Record<string, string> = {}
      for (let i = 0; i < 100_000; i++) huge[`k${i}`] = 'v'
      const line = formatLogEntry('info', [huge])
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(200_000)
      const entry = parse(line)
      expect(entry.field_truncated).toBe(true)
      expect(entry.severity).toBe('INFO')
    })

    it('caps an oversized message (many primitive args, each already under the per-string cap) to the line byte cap', () => {
      // A single huge primitive arg gets caught by the per-part string cap
      // (MAX_STRING_LENGTH) long before the line-size check ever runs — to
      // actually exercise the LINE cap's own truncation, the overflow has to
      // come from the aggregate of many args, each individually legal.
      const part = 'x'.repeat(4_000)
      const line = formatLogEntry('error', Array(200).fill(part))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(200_000)
      const parsed = JSON.parse(line)
      expect(parsed.field_truncated).toBe(true)
      // Confirms real content survived truncation rather than falling all
      // the way to the tiny static "too large" literal — i.e. the byte-cap
      // truncation itself did meaningful, correctly-sized work.
      expect((parsed.message as string).length).toBeGreaterThan(100_000)
    })

    it('caps an oversized multi-byte (emoji) message without splitting a character or emitting invalid JSON', () => {
      // Every character is a 4-byte UTF-8 / surrogate-pair UTF-16 character,
      // so a naive character-count or char-slice truncation would either
      // overshoot the byte cap or split a surrogate pair. The leading 'A' in
      // each part deliberately shifts the code-unit parity from one part to
      // the next, so the eventual truncation point can't line up with a pair
      // boundary "by accident" the way a purely-emoji string aligned at
      // offset 0 could — this is what makes the test actually distinguish a
      // byte-accurate truncation from a naive one instead of passing either way.
      const part = 'A' + '😀'.repeat(1_999)
      const line = formatLogEntry('error', Array(210).fill(part))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(200_000)
      const parsed = JSON.parse(line)
      expect(parsed.field_truncated).toBe(true)
      expect((parsed.message as string).length).toBeGreaterThan(50_000)
      // No lone surrogate half: every remaining char is a complete code point
      // or the U+FFFD replacement character used for a truncated tail.
      const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      expect(UNPAIRED_SURROGATE.test(parsed.message as string)).toBe(false)
    })
  })

  it('stringifies a BigInt argument', () => {
    const entry = parse(formatLogEntry('info', [{ big: 9007199254740993n }]))
    expect(entry.big).toBe('9007199254740993')
  })

  it('produces valid JSON with no embedded newline', () => {
    const line = formatLogEntry('error', ['multi\nline\nstring here', { a: 'b\nc' }])
    expect(line.includes('\n')).toBe(false)
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('never throws even when passed pathological input', () => {
    const weird = {}
    Object.defineProperty(weird, 'poison', {
      enumerable: true,
      get() {
        throw new Error('nope')
      },
    })
    expect(() => formatLogEntry('error', [weird])).not.toThrow()
  })

  it('never throws — and never touches the argument at all — when BOTH a getter and toString throw', () => {
    // This exercises the LAST-RESORT fallback path specifically: buildEntry
    // throws (the poisoned getter), so formatLogEntry's outer catch fires;
    // that fallback must not itself call anything on `weird` — including
    // `String(weird)`, which would invoke the equally-poisoned `toString`.
    const weird: Record<string, unknown> = {}
    Object.defineProperty(weird, 'poison', {
      enumerable: true,
      get() {
        throw new Error('getter boom')
      },
    })
    weird.toString = () => {
      throw new Error('toString boom')
    }
    ;(weird as { [Symbol.toPrimitive]?: () => string })[Symbol.toPrimitive] = () => {
      throw new Error('toPrimitive boom')
    }

    let line = ''
    expect(() => {
      line = formatLogEntry('error', [weird])
    }).not.toThrow()
    expect(() => JSON.parse(line)).not.toThrow()
    const entry = JSON.parse(line)
    expect(entry.severity).toBe('ERROR')
    expect(typeof entry.message).toBe('string')
  })
})
