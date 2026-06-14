// ── Persistence ──────────────────────────────────────────────────────
//
// `layoutMap` learns user keyboard layout observations and exposes them as
// pure in-memory state. The library does not persist anything itself —
// consumers wire their own serialization by subscribing via
// `subscribeLayoutMap` (debounce as desired) and seeding the map at startup
// via `setLayoutMap(...)`.

// ── Types ────────────────────────────────────────────────────────────

/** A mapping from physical key codes (KeyboardEvent.code) to characters. */
export type LayoutMap = Record<string, string>

/** Pluggable layout provider for future extensibility (bundled layouts,
 *  navigator.keyboard.getLayoutMap(), external files, etc.). */
export interface LayoutSource {
  /** Human-readable name shown in the settings UI. */
  name: string
  /** Load a full or partial layout map. Called once during initialization. */
  load(): Promise<LayoutMap> | LayoutMap
}

// ── QWERTY fallback (last-resort) ───────────────────────────────────

/** Hardcoded US-QWERTY code→key mapping. Used as the final fallback when
 *  the learned map has no entry for a given code. */
export const QWERTY_MAP: Readonly<LayoutMap> = /* @__PURE__ */ (() => {
  const m: LayoutMap = {}
  for (const c of 'abcdefghijklmnopqrstuvwxyz') m[`Key${c.toUpperCase()}`] = c
  for (let i = 0; i <= 9; i++) m[`Digit${i}`] = String(i)
  Object.assign(m, {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: ' ',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
  })
  return m
})()

// ── Non-learnable codes ─────────────────────────────────────────────

/** Codes that are layout-independent — QWERTY_MAP is always correct. */
const NON_LEARNABLE = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

// ── Module state ────────────────────────────────────────────────────

let learnedMap: LayoutMap = {}
const listeners = new Set<(map: Readonly<LayoutMap>) => void>()

// ── External sources (future extensibility) ─────────────────────────

interface PrioritizedSource {
  source: LayoutSource
  priority: number
  map: LayoutMap
}
const externalSources: PrioritizedSource[] = []

/** Register an external layout source. Higher priority sources are
 *  consulted before lower ones. The learned map always takes precedence
 *  over external sources; QWERTY is always last. */
export function addLayoutSource(source: LayoutSource, priority: number): void {
  const entry: PrioritizedSource = { source, priority, map: {} }
  externalSources.push(entry)
  externalSources.sort((a, b) => b.priority - a.priority)
  const result = source.load()
  if (result instanceof Promise) {
    result.then(
      (m) => {
        entry.map = m
        notify()
      },
      () => {
        /* source failed to load — ignore */
      },
    )
  } else {
    entry.map = result
    notify()
  }
}

// ── Observation ─────────────────────────────────────────────────────

/** Record a single keypress observation. Each unmodified keypress teaches the
 *  layout map which character a physical key produces. Over time this builds an
 *  accurate per-user layout without requiring an explicit layout selector. Skips
 *  non-learnable codes and multi-character key values (Dead, Unidentified, etc.). */
export function observeKey(code: string, key: string): void {
  if (!code || NON_LEARNABLE.has(code)) return
  if (key.length !== 1) return
  const lower = key.toLowerCase()
  if (learnedMap[code] === lower) return // already known
  learnedMap[code] = lower
  notify()
}

// ── Resolution ──────────────────────────────────────────────────────

/** Resolve a physical key code to a character. Walks the source chain:
 *  learned map → external sources → QWERTY fallback. */
export function resolveCode(code: string): string | undefined {
  const learned = learnedMap[code]
  if (learned !== undefined) return learned
  for (const { map } of externalSources) {
    const ext = map[code]
    if (ext !== undefined) return ext
  }
  return QWERTY_MAP[code]
}

// ── Full map access ─────────────────────────────────────────────────

/** Return the current learned layout map (read-only snapshot). */
export function getLayoutMap(): Readonly<LayoutMap> {
  return learnedMap
}

/** Replace the entire learned map. Used at startup to seed from a
 *  consumer-managed store, and by the settings UI for manual edits.
 *  Notifies subscribers; the consumer decides whether to persist. */
export function setLayoutMap(map: LayoutMap): void {
  learnedMap = { ...map }
  notify()
}

// ── Subscriptions ───────────────────────────────────────────────────

/**
 * Subscribe to learned-layout-map changes. The callback receives a read-only
 * snapshot on every update (debounce in the consumer if persisting). Returns an
 * unsubscribe function.
 */
export function subscribeLayoutMap(cb: (map: Readonly<LayoutMap>) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function notify(): void {
  // Shallow copy so React setState detects the change (same-ref skip)
  const snapshot = { ...learnedMap }
  for (const cb of listeners) cb(snapshot)
}

// ── Test helpers ────────────────────────────────────────────────────

/** Reset module state. Only for use in tests. */
export function _resetForTesting(): void {
  learnedMap = {}
  listeners.clear()
  externalSources.length = 0
}
