import { resolveCode } from './layoutMap.js'

// ── Types ────────────────────────────────────────────────────────────

// TODO: Remove this duplicate of BindingEntry from keyboard/keymap.ts. The two
// definitions exist for legacy reasons; any change to the variant set MUST be
// applied to both, or downstream consumers will see one definition win at the
// type level and behave unexpectedly at runtime.
export type BindingEntry =
  | { type: 'action'; action: string }
  | { type: 'operator'; operator: string }
  | { type: 'motion'; motion: string }
  /**
   * Multi-key chord prefix. The engine captures the inline continuation
   * keymap and waits for the next key (no registry needed).
   */
  | { type: 'prefix'; keymap: Map<string, BindingEntry> }
  | { type: 'passthrough' }

// ── Key normalization ────────────────────────────────────────────────

export interface KeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Resolve the base key from a keyboard event, respecting keyboard layout.
 *  Prefers e.key (layout-aware) for Latin-script layouts (AZERTY, Dvorak, …).
 *  Falls back to resolveCode(e.code) for dead keys and macOS Option composed
 *  Unicode. Non-Latin layouts (Cyrillic, Arabic, …) are not auto-remapped —
 *  users should rebind or switch to a Latin layer for shortcuts. */
export function resolveBaseKey(e: { key: string; code?: string; altKey?: boolean }): string {
  const { key, code, altKey } = e

  if (key === 'Dead' && code) {
    const mapped = resolveCode(code)
    if (mapped) return mapped
  }

  if (altKey && key.length === 1 && key.charCodeAt(0) > 0x7e && code) {
    const mapped = resolveCode(code)
    if (mapped) return mapped
  }

  if (key.length === 1) return key.toLowerCase()

  if (code) {
    const mapped = resolveCode(code)
    if (mapped) return mapped
  }

  return key
}

/** Normalize a keyboard event into a canonical key string like "C-a", "M-b", "C-S-T", "Escape" */
export function normalizeKeyEvent(e: KeyEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null

  let baseKey = resolveBaseKey(e)
  if (e.shiftKey && baseKey.length === 1) baseKey = baseKey.toUpperCase()

  const parts: string[] = []
  if (e.ctrlKey) parts.push('C')
  if (e.altKey) parts.push('M')
  if (e.shiftKey && (baseKey.length > 1 || e.ctrlKey || e.altKey || e.metaKey)) parts.push('S')
  if (e.metaKey) parts.push('s')

  if (parts.length === 0) return baseKey
  parts.push(baseKey.length === 1 ? baseKey.toLowerCase() : baseKey)
  return parts.join('-')
}
