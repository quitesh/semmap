/**
 * The table-driven stepper: a DPDA whose transition function is the LL(1) table
 * built in `compile.ts`. The config is plain, serializable data — it **is**
 * {@link ParseState}, the engine snapshot.
 *
 * On each key we run the predictive-parser loop:
 *   - pop the top stack symbol;
 *   - nonterminal: look up `M[nt, key] ?? M[nt, LIT_COL]`; push the chosen
 *     production's body (reversed). An EPS-only nullable nt with no column for
 *     the key pops (nullable-complete) and retries the key against what's beneath;
 *   - terminal: consume the key, apply the symbol's output-register effect;
 *   - dead end: `started ? cancelled (eat) : unmatched (yield)`.
 *
 * Exactly one terminal consumption per key. Registers are output-only: effects
 * write them, `finalize` reads them, nothing reads them to gate a match. Which
 * count slot a digit feeds comes from the **digit symbol's `slot`** (its grammar
 * position), never from a flag.
 */

import { type Builder, type Command, finalize, freshBuilder } from './command.js'
import { EPS_COL, LIT_COL, type Sym, type Table } from './compile.js'
import type { Eff } from './matcher.js'

/**
 * The DPDA configuration == the engine snapshot. `stack` top is the LAST element
 * (we push/pop from the end). `started` drives the dead-end policy (unmatched vs
 * cancelled). Plain, serializable data — no hidden call-stack or generator state.
 */
export interface ParseState {
  stack: Sym[]
  builder: Builder
  started: boolean
}

export function initialState(table: Table): ParseState {
  return {
    stack: [{ s: 'nt', name: table.grammar.start }],
    builder: freshBuilder(),
    started: false,
  }
}

export type StepResult =
  | { status: 'resolved'; command: Command; state: ParseState }
  | { status: 'pending'; state: ParseState }
  | { status: 'cancelled'; state: ParseState }
  | { status: 'unmatched'; state: ParseState }

// ── effect application (output-only registers) ───────────────────────

/**
 * Apply an effect to the (output-only) builder. Effects only WRITE registers;
 * none reads builder state to gate a match (the recognizer is purely structural).
 */
function applyEff(b: Builder, eff: Eff, consumedKey: string): void {
  switch (eff.kind) {
    case 'operator':
      b.operator = eff.id
      break
    case 'motion':
      b.motionId = eff.id
      break
    case 'action':
      b.action = eff.id
      break
    case 'linewise':
      b.linewise = true
      break
    case 'to-scope':
      b.toScope = eff.scope
      break
    case 'to-object':
      b.toObject = eff.id
      break
    case 'find-marker':
      b.motionId = eff.id
      break
    case 'find-arg':
      b.motionArg = consumedKey
      break
    case 'uarg':
      applyUarg(b, eff.op, consumedKey)
      break
    case 'passthrough':
      b.passthrough = true
      break
  }
}

/**
 * The universal-argument register transitions. Mirrors the oracle's `C-u` FSM:
 *   init   → value 4, kind plain, sign +1
 *   times4 → plain: ×4;  numeric: reset to 4 / plain
 *   digit  → plain: value = digit, kind numeric;  numeric: ×10 + digit
 *   sign   → flip sign (always reachable only at the bare `C-u -4` state, since the
 *            grammar offers `-` solely there — see `prefixArg.ts`)
 *
 * `times4`/`digit` read `uargKind` to COMPUTE the output value (×4 vs reset,
 * replace vs append) — that is value math, NOT match gating. The match is decided
 * entirely by grammar structure; these reads never reject a key.
 */
function applyUarg(b: Builder, op: 'init' | 'times4' | 'digit' | 'sign', key: string): void {
  switch (op) {
    case 'init':
      b.uargValue = 4
      b.uargKind = 'plain'
      b.uargSign = 1
      break
    case 'times4':
      // Compute-only branch on kind (plain ×4 vs numeric reset); not a gate.
      if (b.uargKind === 'plain') {
        b.uargValue = (b.uargValue ?? 4) * 4
      } else {
        b.uargValue = 4
        b.uargKind = 'plain'
        b.uargSign = 1
      }
      break
    case 'digit': {
      // Compute-only branch on kind (plain replace vs numeric append); not a gate.
      const d = Number(key)
      if (b.uargKind === 'plain') {
        b.uargValue = d
        b.uargKind = 'numeric'
      } else {
        b.uargValue = (b.uargValue ?? 0) * 10 + d
      }
      break
    }
    case 'sign':
      // Grammar guarantees we only get here at the bare state, so flip uncondition-
      // ally — no state check, no reject.
      b.uargSign = -1
      break
  }
}

function accumulateCount(b: Builder, slot: 1 | 2, digit: number): void {
  if (slot === 2) b.count2 = (b.count2 ?? 0) * 10 + digit
  else b.count1 = (b.count1 ?? 0) * 10 + digit
}

// ── step ─────────────────────────────────────────────────────────────

export function step(table: Table, state: ParseState, k: string): StepResult {
  const stack: Sym[] = [...state.stack]
  const builder: Builder = { ...state.builder }
  let started = state.started

  const deadEnd = (): StepResult => ({
    status: started ? 'cancelled' : 'unmatched',
    state: initialState(table),
  })

  for (let guard = 0; guard < 10000; guard++) {
    if (stack.length === 0) return deadEnd()
    const top = stack[stack.length - 1]

    if (top.s === 'nt') {
      const row = table.M.get(top.name)
      if (!row) return deadEnd()
      // Plain column lookup: concrete key, then the wildcard `literal` column.
      const prod = row.get(k) ?? row.get(LIT_COL)
      if (!prod) {
        // No column for this key. If the nonterminal is nullable (eps entry),
        // complete it (pop) and retry the key against what's beneath.
        const epsProd = row.get(EPS_COL)
        if (epsProd && epsProd.body.length === 0) {
          stack.pop()
          continue
        }
        return deadEnd()
      }
      stack.pop()
      // push body in reverse so body[0] ends up on top
      for (let i = prod.body.length - 1; i >= 0; i--) stack.push(prod.body[i])
      continue
    }

    if (top.s === 'digit') {
      // A count-digit terminal. It is only ever pushed when the table routed the
      // key into a digit column, so the key is already a valid digit for this
      // slot — accumulate Number(key). The slot is position-derived (from the
      // symbol), never a flag read.
      stack.pop()
      accumulateCount(builder, top.slot, Number(k))
      started = true
      return settle(table, stack, builder, started)
    }

    if (top.s === 'term') {
      if (top.key !== k) return deadEnd()
      stack.pop()
      if (top.eff) applyEff(builder, top.eff, k)
      started = true
      return settle(table, stack, builder, started)
    }

    if (top.s === 'group') {
      const eff = table.grammar.registry[top.name]?.get(k)
      if (!eff) return deadEnd()
      stack.pop()
      applyEff(builder, eff, k)
      started = true
      return settle(table, stack, builder, started)
    }

    // top.s === 'lit': wildcard, matches ANY key (the default transition).
    stack.pop()
    applyEff(builder, top.eff, k)
    started = true
    return settle(table, stack, builder, started)
  }
  return deadEnd()
}

function settle(table: Table, stack: Sym[], builder: Builder, started: boolean): StepResult {
  drainNullable(table, stack)
  if (stack.length === 0) {
    return { status: 'resolved', command: finalize(builder), state: initialState(table) }
  }
  return { status: 'pending', state: { stack, builder, started } }
}

/**
 * Online-acceptance: collapse **only the sole trailing nullable** to decide
 * resolved-vs-pending. We pop a nullable nonterminal ONLY when it is the LAST
 * thing on the stack (a trailing count tail / optional at end-of-command). We
 * NEVER drain all nullable tails — that would silently drop an in-progress count
 * (`10w`, `d2…`). Greedy-repeat completion is driven only by the repeat seeing a
 * non-matching key, never by a generic nullable-draining pass.
 */
function drainNullable(table: Table, stack: Sym[]): void {
  for (let guard = 0; guard < 10000; guard++) {
    if (stack.length !== 1) return
    const top = stack[0]
    if (top.s !== 'nt') return
    const row = table.M.get(top.name)
    const epsProd = row?.get(EPS_COL)
    const isNullable = epsProd && epsProd.body.length === 0
    if (!isNullable) return
    stack.pop()
  }
}
