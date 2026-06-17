/**
 * THE GATE: differential parity between the live {@link KeyboardEngine} (the
 * oracle) and the compiled-recognizer harness {@link RecognizerEngine}. For a
 * shared set of small keymaps + key sequences, identical `KeyEvent`s are fed to
 * BOTH engines and the resulting `EngineResult`s (`type`, `action`, `count`,
 * `pendingDisplay`) must match at every step.
 *
 * Covers slice 1a's ported grammars: leading count, simple actions, and the
 * emacs universal argument — including the `C-u` edges and the C-g/Escape
 * cancel-to-unmatched parity carve-out.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type EngineResult,
  KeyboardEngine,
  type KeymapSource,
} from '../../keyboardEngine.js'
import type { BindingEntry, KeyEvent } from '../../modeRegistry.js'
import { keymapGrammar } from './keymapGrammar.js'
import { RecognizerEngine, type RecognizerResult } from './recognizerEngine.js'

const UARG = 'action.universalArgument'

// ── KeyEvent helper ──────────────────────────────────────────────────
// Drives BOTH engines from the SAME KeyEvent. Supports `C-x`, `Escape`, etc.

function ev(spec: string): KeyEvent {
  let key = spec
  let ctrlKey = false
  let altKey = false
  let shiftKey = false
  if (key.startsWith('C-')) {
    ctrlKey = true
    key = key.slice(2)
  }
  if (key.startsWith('M-')) {
    altKey = true
    key = key.slice(2)
  }
  if (key.startsWith('S-')) {
    shiftKey = true
    key = key.slice(2)
  }
  return { key, ctrlKey, altKey, shiftKey, metaKey: false }
}

// ── KeymapSource from a flat Map ─────────────────────────────────────

function mapSource(map: Map<string, BindingEntry>, acceptsLeadingCount: boolean): KeymapSource {
  return {
    iterateKeymaps: () => [map],
    acceptsLeadingCount: () => acceptsLeadingCount,
  }
}

// ── Result normalization (compare the shared subset) ─────────────────

interface Norm {
  type: string
  action?: string
  count?: number
  pendingDisplay?: string
}

function normEngine(r: EngineResult): Norm {
  const n: Norm = { type: r.type }
  if (r.action !== undefined) n.action = r.action
  if (r.count !== undefined) n.count = r.count
  if (r.pendingDisplay !== undefined) n.pendingDisplay = r.pendingDisplay
  return n
}

function normRec(r: RecognizerResult): Norm {
  const n: Norm = { type: r.type }
  if (r.action !== undefined) n.action = r.action
  if (r.count !== undefined) n.count = r.count
  if (r.pendingDisplay !== undefined) n.pendingDisplay = r.pendingDisplay
  return n
}

// ── Differential driver: feed the SAME events, assert step-by-step ───

function runBoth(
  map: Map<string, BindingEntry>,
  acceptsLeadingCount: boolean,
  keys: string[],
): { engine: Norm; rec: Norm }[] {
  const engine = new KeyboardEngine(mapSource(map, acceptsLeadingCount), {
    universalArgAction: UARG,
  })
  const { table } = keymapGrammar({
    keymaps: [map],
    acceptsLeadingCount,
    universalArgAction: UARG,
  })
  const rec = new RecognizerEngine(table)

  const steps: { engine: Norm; rec: Norm }[] = []
  for (const k of keys) {
    const e = ev(k)
    const en = normEngine(engine.processKey(e))
    const rn = normRec(rec.processKey(e))
    steps.push({ engine: en, rec: rn })
  }
  return steps
}

function assertParity(
  map: Map<string, BindingEntry>,
  acceptsLeadingCount: boolean,
  keys: string[],
): void {
  const steps = runBoth(map, acceptsLeadingCount, keys)
  steps.forEach((s, i) => {
    expect(s.rec, `key #${i} ('${keys[i]}') of [${keys.join(',')}]`).toEqual(s.engine)
  })
}

// ── Keymaps ──────────────────────────────────────────────────────────

const countMap = new Map<string, BindingEntry>([['x', { type: 'action', action: 'act.x' }]])

const uargMap = new Map<string, BindingEntry>([
  ['C-u', { type: 'action', action: UARG }],
  ['a', { type: 'action', action: 'act.a' }],
])

// =====================================================================
// Count (acceptsLeadingCount = true)
// =====================================================================

describe('differential: count + simple actions', () => {
  const cases: string[][] = [
    ['x'], // bare action -> count 1
    ['2', 'x'], // count 2
    ['2', '3', 'x'], // count 23
    ['2'], // pending "2"
    ['2', '3'], // pending "2 3"
    ['0'], // fresh 0 -> unmatched (no 0 binding)
    ['1', '0', 'x'], // 0-rule mid-count -> count 10
    ['z'], // fresh unbound -> unmatched
    ['2', 'z'], // dead-end mid-count -> unmatched, count preserved
    ['2', 'z', 'x'], // ...then x still counts 2
  ]
  for (const keys of cases) {
    it(`'${keys.join(' ')}'`, () => assertParity(countMap, true, keys))
  }
})

// =====================================================================
// Universal argument (acceptsLeadingCount = false)
// =====================================================================

describe('differential: universal argument', () => {
  const cases: string[][] = [
    ['C-u', 'a'], // 4
    ['C-u', 'C-u', 'a'], // 16
    ['C-u', 'C-u', 'C-u', 'a'], // 64
    ['C-u', '5', 'a'], // 5
    ['C-u', '5', '0', 'a'], // 50
    ['C-u', '-', 'a'], // -4
    // pending displays
    ['C-u'], // "C-u 4"
    ['C-u', 'C-u'], // "C-u 16"
    ['C-u', '5'], // "C-u 5"
    ['C-u', '-'], // "C-u -4"
    // odd ones — assert both engines AGREE, whatever they do
    ['C-u', '3', '-'], // sign rule needs plain; here numeric
    ['C-u', '3', '-', 'a'],
    ['C-u', '-', '-'], // sign already flipped
    ['C-u', '-', '-', 'a'],
    // `C-u` staying in the loop after a digit/sign — must track the oracle
    ['C-u', '5', 'C-u', 'a'], // C-u after a digit resets -> 4
    ['C-u', '-', '5', 'C-u', 'a'], // sign then digit then C-u reset
    ['C-u', '5', 'C-u', '3', 'a'], // reset then a fresh digit
    // a key that simply isn't a uarg continuation nor a bound action
    ['C-u', 'z'],
    ['C-u', 'z', 'a'],
  ]
  for (const keys of cases) {
    it(`'${keys.join(' ')}'`, () => assertParity(uargMap, false, keys))
  }
})

// =====================================================================
// C-g / Escape cancel parity
// =====================================================================

describe('differential: C-g / Escape cancel-to-unmatched', () => {
  it('C-u then Escape -> unmatched + reset', () => {
    const steps = runBoth(uargMap, false, ['C-u', 'Escape', 'a'])
    expect(steps[1].engine.type).toBe('unmatched')
    expect(steps[1].rec.type).toBe('unmatched')
    // after reset, a fresh `a` resolves with count 1 in BOTH
    expect(steps[2].rec).toEqual(steps[2].engine)
    expect(steps[2].engine.count).toBe(1)
  })
  it('2 then Escape -> unmatched + reset', () => {
    const steps = runBoth(countMap, true, ['2', 'Escape', 'x'])
    expect(steps[1].engine.type).toBe('unmatched')
    expect(steps[1].rec.type).toBe('unmatched')
    expect(steps[2].rec).toEqual(steps[2].engine)
    expect(steps[2].engine.count).toBe(1)
  })
  it('C-u 5 then C-g -> unmatched + reset', () => {
    const steps = runBoth(uargMap, false, ['C-u', '5', 'C-g', 'a'])
    expect(steps[2].engine.type).toBe('unmatched')
    expect(steps[2].rec.type).toBe('unmatched')
    expect(steps[3].rec).toEqual(steps[3].engine)
    expect(steps[3].engine.count).toBe(1)
  })
})

// =====================================================================
// Invariant lock: no effect reads builder state to GATE a match.
// The `-` is gated purely structurally (grammar position), so `applyUarg`/
// `applyEff` must never return/use a 'reject' dead-end path.
// =====================================================================

describe('invariant: effects never gate a match (no reject path)', () => {
  it('step.ts has no \'reject\' effect-gating mechanism', () => {
    const stepSrc = readFileSync(
      fileURLToPath(new URL('./step.ts', import.meta.url)),
      'utf8',
    )
    // The only reject mentions allowed are in comments asserting its absence.
    const codeLines = stepSrc
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n')
    expect(codeLines).not.toContain('reject')
  })
})
