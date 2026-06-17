/**
 * Differential oracle: an independent **tree-interpreter** over the neutral
 * command-grammar AST, kept deliberately as a second implementation for
 * differential testing. The production path (`compile.ts` + `step.ts`) compiles
 * the same grammar into an LL(1) table and is what ships; this interpreter walks
 * the {@link Matcher} tree directly. `differential.test.ts` runs both over the
 * same vim grammar and asserts byte-identical output — so this oracle is the
 * ground truth the compiled core must match.
 *
 * It is also the only test exercising the FULL vim grammar (operators, doubling,
 * text-objects), which is not yet wired through the engine. Test-support only —
 * never imported by production code.
 *
 * The recognizer is a deterministic pushdown recognizer: online, zero-lookahead,
 * one key per `step`. State registers are output-only: written by effects and
 * read only at finalize time — NEVER read to gate a match. (The one apparent
 * exception, `sawOperator`, is examined inline.)
 */

import type { Eff, Matcher, Registry } from '../matcher.js'

// ── Builder: output-only registers ───────────────────────────────────

interface Builder {
  count1?: number
  count2?: number
  sawOperator: boolean
  operator?: string
  motionId?: string
  motionArg?: string
  action?: string
  linewise?: boolean
  toScope?: 'i' | 'a'
  toObject?: string
}

function freshBuilder(): Builder {
  return { sawOperator: false }
}

// ── ParseState ───────────────────────────────────────────────────────
//
// stack: top = LAST element (we push, pop from the end).
// started: has anything been consumed since the last reset? Drives the
// dead-end policy (unmatched vs cancelled).

export interface ParseState {
  stack: Matcher[]
  builder: Builder
  started: boolean
}

// ── Resolved command ─────────────────────────────────────────────────

export interface Command {
  count?: number
  operator?: string
  motion?: { id: string; arg?: string; count?: number }
  textObject?: { scope: 'i' | 'a'; id: string }
  linewise?: boolean
  action?: string
}

// ── Step result ──────────────────────────────────────────────────────

export type StepResult =
  | { status: 'resolved'; command: Command; state: ParseState }
  | { status: 'pending'; state: ParseState }
  | { status: 'cancelled'; state: ParseState }
  | { status: 'unmatched'; state: ParseState }

// ── Recognizer = grammar + registry ──────────────────────────────────

export interface Recognizer {
  grammar: Matcher
  registry: Registry
}

export function makeRecognizer(grammar: Matcher, registry: Registry): Recognizer {
  return { grammar, registry }
}

export function initialState(rec: Recognizer): ParseState {
  return { stack: [rec.grammar], builder: freshBuilder(), started: false }
}

// ── FIRST sets ───────────────────────────────────────────────────────
//
// FIRST(m) over canonical KEY terminals. `null` => nullable. `'*'` => literal
// (matches any key). Used by `choice` to pick the unique alt whose FIRST
// contains the key (FIRST/FIRST disjoint => at most one).

const COUNT_START = '123456789'.split('') // `0` is not a count-start (the 0-rule)

function first(m: Matcher, reg: Registry): Set<string | null> {
  switch (m.t) {
    case 'key':
      return new Set([m.key])
    case 'group':
      return new Set(reg[m.name] ? [...reg[m.name].keys()] : [])
    case 'literal':
      return new Set(['*'])
    case 'count':
      return new Set<string | null>([...COUNT_START, null])
    case 'star': {
      const out = new Set<string | null>()
      for (const x of m.xs) for (const k of first(x, reg)) out.add(k)
      out.add(null) // star is nullable
      return out
    }
    case 'seq': {
      const out = new Set<string | null>()
      let nullablePrefix = true
      for (const x of m.xs) {
        const f = first(x, reg)
        for (const k of f) if (k !== null) out.add(k)
        if (!f.has(null)) {
          nullablePrefix = false
          break
        }
      }
      if (nullablePrefix) out.add(null)
      return out
    }
    case 'choice': {
      const out = new Set<string | null>()
      for (const x of m.xs) for (const k of first(x, reg)) out.add(k)
      return out
    }
  }
}

function firstAdmits(m: Matcher, reg: Registry, k: string): boolean {
  const f = first(m, reg)
  return f.has(k) || f.has('*')
}

// ── count helper ─────────────────────────────────────────────────────

function isCountDigit(k: string, current: number | undefined): boolean {
  if (k.length !== 1) return false
  if (k >= '1' && k <= '9') return true
  // The 0-rule: `0` is a count-digit ONLY if the count already has digits.
  if (k === '0') return current !== undefined
  return false
}

// ── effect application ───────────────────────────────────────────────
//
// Effects write output-only registers. `find-arg` captures the consumed key.

function applyEff(b: Builder, eff: Eff, consumedKey: string): void {
  switch (eff.kind) {
    case 'operator':
      b.operator = eff.id
      b.sawOperator = true
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
  }
}

// ── finalize ─────────────────────────────────────────────────────────

function finalize(b: Builder): Command {
  const cmd: Command = {}
  // Effective count: (count1 ?? 1) * (count2 ?? 1), set only if either present.
  if (b.count1 !== undefined || b.count2 !== undefined) {
    cmd.count = (b.count1 ?? 1) * (b.count2 ?? 1)
  }
  if (b.operator !== undefined) cmd.operator = b.operator
  if (b.linewise) cmd.linewise = true
  if (b.action !== undefined) cmd.action = b.action
  if (b.toObject !== undefined) cmd.textObject = { scope: b.toScope ?? 'i', id: b.toObject }
  if (b.motionId !== undefined) {
    cmd.motion = { id: b.motionId }
    if (b.motionArg !== undefined) cmd.motion.arg = b.motionArg
  }
  return cmd
}

// ── step ─────────────────────────────────────────────────────────────
//
// Process exactly one key. Loops over zero-consume structural expansions
// (seq/choice/nullable-count-completion) until a key is consumed, the parse
// dead-ends, or it completes.

export function step(rec: Recognizer, state: ParseState, k: string): StepResult {
  const reg = rec.registry
  const stack = [...state.stack]
  const builder: Builder = { ...state.builder }
  let started = state.started

  const deadEnd = (): StepResult => {
    const reset = initialState(rec)
    // fresh start (nothing consumed) -> yield to native; mid-parse -> eat.
    return started
      ? { status: 'cancelled', state: reset }
      : { status: 'unmatched', state: reset }
  }

  for (let guard = 0; guard < 10000; guard++) {
    if (stack.length === 0) return deadEnd()
    const top = stack[stack.length - 1]

    switch (top.t) {
      case 'seq': {
        stack.pop()
        for (let i = top.xs.length - 1; i >= 0; i--) stack.push(top.xs[i])
        continue
      }
      case 'star': {
        // greedy nullable repeat: if the key starts an alt, take it (re-pushing
        // the star so it can repeat); otherwise nullable-complete and re-try.
        const alt = top.xs.find((x) => firstAdmits(x, reg, k))
        if (alt) {
          stack.push(alt)
          continue
        }
        stack.pop()
        continue
      }
      case 'choice': {
        const alt = top.xs.find((x) => firstAdmits(x, reg, k))
        if (!alt) return deadEnd()
        stack.pop()
        stack.push(alt)
        continue
      }
      case 'count': {
        const cur = builder.sawOperator ? builder.count2 : builder.count1
        if (isCountDigit(k, cur)) {
          const next = (cur ?? 0) * 10 + Number(k)
          if (builder.sawOperator) builder.count2 = next
          else builder.count1 = next
          started = true
          // greedy: keep `count` on the stack, consume the digit.
          return settle(rec, stack, builder, started)
        }
        // not a digit: nullable-complete, pop and re-try the key.
        stack.pop()
        continue
      }
      case 'key': {
        if (top.key === k) {
          stack.pop()
          if (top.eff) applyEff(builder, top.eff, k)
          started = true
          return settle(rec, stack, builder, started)
        }
        return deadEnd()
      }
      case 'group': {
        const eff = reg[top.name]?.get(k)
        if (eff) {
          stack.pop()
          applyEff(builder, eff, k)
          started = true
          return settle(rec, stack, builder, started)
        }
        return deadEnd()
      }
      case 'literal': {
        stack.pop()
        applyEff(builder, top.eff, k)
        started = true
        return settle(rec, stack, builder, started)
      }
    }
  }
  return deadEnd()
}

// settle: after a key is consumed, drain trivially-complete frames and decide
// resolved vs pending.
function settle(rec: Recognizer, stack: Matcher[], builder: Builder, started: boolean): StepResult {
  drainStructural(stack)
  if (stack.length === 0) {
    return { status: 'resolved', command: finalize(builder), state: initialState(rec) }
  }
  return { status: 'pending', state: { stack, builder, started } }
}

// drainStructural: expand trailing empty/nested seqs so the stack top reflects
// the next thing that genuinely requires input. We deliberately do NOT pop
// `count` here: a `count` on top is either greedily mid-accumulation (just
// consumed a digit -> still wants more -> pending) or sitting at the count2
// position waiting (pending). A nullable `count` only completes-empty via the
// `count` case in `step` itself, which pops it and re-tries the key. Popping
// counts here would destroy an in-progress count (the `10w` / `d2` bug).
function drainStructural(stack: Matcher[]): void {
  for (let guard = 0; guard < 10000; guard++) {
    if (stack.length === 0) return
    const top = stack[stack.length - 1]
    if (top.t === 'seq') {
      stack.pop()
      for (let i = top.xs.length - 1; i >= 0; i--) stack.push(top.xs[i])
      continue
    }
    return
  }
}
