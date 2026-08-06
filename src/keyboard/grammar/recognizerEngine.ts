/**
 * A thin TEST/PREVIEW harness around the compiled recognizer that mimics the
 * live {@link KeyboardEngine}'s `processKey → EngineResult` surface. It exists to
 * differential-test the recognizer against the real engine and to preview the
 * eventual swap; it is NOT the production engine and holds no overlay/timer state.
 *
 * Pipeline: `normalizeKeyEvent` → C-g/Escape parity carve-out → {@link step} →
 * map {@link StepResult} to an `EngineResult`-shaped object, deriving
 * `pendingDisplay` from {@link ParseState} in the oracle's exact format.
 *
 * Two behaviours reproduce the live engine's prefix semantics that the core
 * stepper alone does not (the plan's §"C-g / Escape" parity carve-out, extended
 * to all in-progress prefixes):
 *   - **C-g / Escape while a prefix (count or uarg) is in progress** resets and
 *     yields `unmatched` (NOT `chordCancelled`).
 *   - **Any other dead-end while a prefix is in progress** (an unbound key, or a
 *     `-` with no grammar position, e.g. after a digit) yields `unmatched` but
 *     PRESERVES the prefix — matching
 *     the live engine, where such keys fall through to `resolveKey` (unmatched)
 *     without clearing the pending count / universal-argument.
 */

import { type KeyEvent, normalizeKeyEvent } from '../../modeRegistry.js'
import type { Builder } from './command.js'
import type { Table } from './compile.js'
import { initialState, type ParseState, step } from './step.js'

/** The `EngineResult`-shaped output (the subset slice 1a compares on). */
export interface RecognizerResult {
  type: 'action' | 'passthrough' | 'pending' | 'unmatched' | 'composing'
  action?: string
  count?: number
  pendingDisplay?: string
}

export class RecognizerEngine {
  private state: ParseState

  constructor(private readonly table: Table) {
    this.state = initialState(table)
  }

  reset(): void {
    this.state = initialState(this.table)
  }

  processKey(e: KeyEvent): RecognizerResult {
    if ((e as { isComposing?: boolean }).isComposing) return { type: 'composing' }
    const k = normalizeKeyEvent(e)
    if (!k) return { type: 'unmatched' }

    const prior = this.state

    // C-g / Escape parity: cancel an in-progress prefix → reset + yield (never eat).
    if ((k === 'C-g' || k === 'Escape') && prior.started) {
      this.state = initialState(this.table)
      return { type: 'unmatched' }
    }

    const r = step(this.table, prior, k)
    switch (r.status) {
      case 'resolved': {
        this.state = r.state
        const b = r.command
        if (b.passthrough) return { type: 'passthrough' }
        // The live engine always reports a count (default 1); finalize only sets
        // it when a prefix was present, so default here to match.
        return { type: 'action', action: b.action, count: b.count ?? 1 }
      }
      case 'pending':
        this.state = r.state
        return { type: 'pending', pendingDisplay: pendingDisplay(r.state) }
      case 'cancelled':
      case 'unmatched':
        // A dead-end. If a prefix was in progress, preserve it and yield
        // unmatched (the live engine falls through to resolveKey without
        // clearing the pending count / universal-argument). Otherwise reset.
        if (prior.started) {
          this.state = prior
        } else {
          this.state = initialState(this.table)
        }
        return { type: 'unmatched' }
    }
  }
}

/** Derive the modeline string from the parse stack, in the live engine's format. */
function pendingDisplay(state: ParseState): string {
  const b: Builder = state.builder
  if (b.uargValue !== undefined) {
    const sign = b.uargSign === -1 ? '-' : ''
    return `C-u ${sign}${b.uargValue}`
  }
  // A leading count in progress: the live engine joins the pressed digit keys with
  // spaces. The decimal digits of the accumulated value reproduce those keystrokes
  // (each count digit is one 0-9 key), so split the value back into space-joined
  // digits.
  const c = b.count1 ?? b.count2
  if (c !== undefined) return String(c).split('').join(' ')
  return ''
}
