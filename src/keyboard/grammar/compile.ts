/**
 * The grammar compiler: turns a {@link Matcher} tree into an explicit LL(1) parse
 * table (a DPDA transition function) over **concrete input-key columns**, and
 * checks admissibility as it fills the table.
 *
 * The table is keyed on concrete keys (`'w'`, `'d'`, `'0'` …) plus the wildcard
 * {@link LIT_COL} and the {@link EPS_COL} nullability marker. There are **no
 * synthetic digit-class columns**: a count's digit terminal expands to concrete
 * digit columns at table-fill (`'1'..'9'` for a fresh count, `'0'..'9'` for a
 * count tail), so the one sanctioned greedy-repeat precedence — continue over
 * exit — resolves into a single static cell at construction. There is no runtime
 * tie-break.
 *
 * Admissibility *is* table construction: a cell that would take two productions is
 * a FIRST/FIRST or FIRST/FOLLOW conflict (except the sanctioned greedy overlap,
 * which is filled by precedence). Plus left-recursion / nullable-cycle checks. A
 * conflict throws {@link AdmissibilityError}.
 */

import type { Eff, Matcher, Registry } from './matcher.js'

// ── Special columns ──────────────────────────────────────────────────

/** The wildcard `literal` "any key" / default column. */
export const LIT_COL = ' any'
/** The nullable-complete / FOLLOW (end-of-input) column. */
export const EPS_COL = ' eps'

/** Concrete digit columns a fresh count offers (1-9; `0` falls through). */
const DIGITS_FRESH = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
/** Concrete digit columns a count tail offers (0-9; `0` continues). */
const DIGITS_TAIL = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

// ── Grammar symbols ──────────────────────────────────────────────────

/**
 * A compiled production is a flat sequence of {@link Sym}s. The DPDA stack holds
 * Syms — this is exactly `ParseState.stack` in `step.ts`.
 *
 * - `term` — a concrete key terminal (one column), carrying its effect.
 * - `digit` — a count-digit accumulator terminal. `slot` is which count slot it
 *   feeds (position-derived); `tail` selects its FIRST columns (1-9 vs 0-9). The
 *   stepper accumulates `Number(key)`; it carries no per-digit effect.
 * - `group` — a namespace reference; each member key is its own column, but it
 *   stays one symbol so the stepper can look up the member effect.
 * - `lit` — the wildcard `literal` terminal = the {@link LIT_COL} column.
 * - `nt` — a nonterminal reference (push its chosen production's body).
 */
export type Sym =
  | { s: 'term'; key: string; eff?: Eff }
  | { s: 'digit'; slot: 1 | 2; tail: boolean }
  | { s: 'group'; name: string }
  | { s: 'lit'; eff: Eff }
  | { s: 'nt'; name: string }

export interface Production {
  id: number // stable id, for diagnostics & differential identity
  body: Sym[]
}

export interface Grammar {
  start: string
  prods: Map<string, Production[]> // nonterminal → alternative productions
  registry: Registry
}

export interface Table {
  grammar: Grammar
  M: Map<string, Map<string, Production>> // M[nt][concreteColumn] = production
  first: Map<string, Set<string>>
  follow: Map<string, Set<string>>
}

// ── Compile errors (admissibility = table construction) ──────────────

export type CompileError =
  | { kind: 'first-first'; nt: string; column: string; prods: [number, number]; message: string }
  | { kind: 'first-follow'; nt: string; column: string; prods: [number, number]; message: string }
  | { kind: 'left-recursion'; nt: string; message: string }

export class AdmissibilityError extends Error {
  constructor(public errors: CompileError[]) {
    super(`grammar inadmissible:\n${errors.map((e) => '  - ' + e.message).join('\n')}`)
    this.name = 'AdmissibilityError'
  }
}

// =====================================================================
// 1. Compile the combinator tree to a named CFG
// =====================================================================
//
// We flatten the Matcher tree into named nonterminals, naming by STRUCTURAL
// POSITION (a fresh name per choice/count node). So the top-level `count`
// (count1, pre-operator) and the per-operator `count` (count2, operand) become
// DISTINCT nonterminals with distinct table entries: the table routes a digit by
// WHERE we are in the stack, never by a flag.

interface CompileCtx {
  prods: Map<string, Production[]>
  nextProdId: { n: number }
  nameCounts: Map<string, number>
}

function freshName(ctx: CompileCtx, base: string): string {
  const n = (ctx.nameCounts.get(base) ?? 0) + 1
  ctx.nameCounts.set(base, n)
  return n === 1 ? base : `${base}#${n}`
}

function addProd(ctx: CompileCtx, nt: string, body: Sym[]): Production {
  const prod: Production = { id: ctx.nextProdId.n++, body }
  const arr = ctx.prods.get(nt) ?? []
  arr.push(prod)
  ctx.prods.set(nt, arr)
  return prod
}

/** The count slot a count nonterminal feeds: slot 1 is the first count node, slot 2+ are operand counts. */
function countSlotFor(ctx: CompileCtx): 1 | 2 {
  // freshName increments `count` before we read it; the first `count` node sees
  // count = 1, the second sees 2, etc. Slot 1 is count1; everything else feeds count2.
  return (ctx.nameCounts.get('count') ?? 1) === 1 ? 1 : 2
}

function compileBody(m: Matcher, ctx: CompileCtx): Sym[] {
  switch (m.t) {
    case 'key':
      return [{ s: 'term', key: m.key, eff: m.eff }]
    case 'group':
      return [{ s: 'group', name: m.name }]
    case 'literal':
      return [{ s: 'lit', eff: m.eff }]
    case 'count': {
      // The greedy [0-9]* count compiles to right-recursive nonterminals. The
      // 0-RULE (0 is a count-digit only MID-count, not at a fresh slot) is
      // encoded PURELY STRUCTURALLY by splitting fresh vs tail position:
      //     Cfresh -> digit(fresh: 1-9) Ctail | eps   (0 falls through to eps)
      //     Ctail  -> digit(tail:  0-9) Ctail | eps   (0 continues the count)
      // No runtime "does the count have digits yet?" read — the stack symbol
      // (Cfresh vs Ctail) IS that distinction. Right recursion keeps it LL(1).
      // A FRESH pair per count node => count1 and count2 are distinct entries.
      // The digit symbol's FIRST columns are CONCRETE keys (see firstColumnsOfSym),
      // so the table has no synthetic digit-class column.
      const fresh = freshName(ctx, 'count')
      const slot = countSlotFor(ctx)
      const tail = `${fresh}.tail`
      ctx.prods.set(fresh, [])
      ctx.prods.set(tail, [])
      addProd(ctx, fresh, [{ s: 'digit', slot, tail: false }, { s: 'nt', name: tail }])
      addProd(ctx, fresh, []) // eps exit
      addProd(ctx, tail, [{ s: 'digit', slot, tail: true }, { s: 'nt', name: tail }])
      addProd(ctx, tail, []) // eps exit
      return [{ s: 'nt', name: fresh }]
    }
    case 'star': {
      // A greedy `(x1 | … | xn)*`: a right-recursive nonterminal whose every
      // non-eps alternative ends by recursing into itself, plus an eps exit. The
      // completion-only-on-non-match discipline falls out of LL(1): the repeat
      // stays on the stack (pending) until a key arrives that is in neither any
      // alternative's FIRST nor would re-enter, at which point the eps exit (via
      // FOLLOW) completes it. Alternatives must be FIRST-disjoint from each other
      // and from the repeat's FOLLOW (checked at table-fill, like any choice).
      const nt = freshName(ctx, 'star')
      ctx.prods.set(nt, [])
      for (const x of m.xs) {
        addProd(ctx, nt, [...compileBody(x, ctx), { s: 'nt', name: nt }])
      }
      addProd(ctx, nt, []) // eps exit
      return [{ s: 'nt', name: nt }]
    }
    case 'seq': {
      const out: Sym[] = []
      for (const x of m.xs) out.push(...compileBody(x, ctx))
      return out
    }
    case 'choice': {
      const nt = freshName(ctx, 'choice')
      ctx.prods.set(nt, [])
      for (const x of m.xs) addProd(ctx, nt, compileBody(x, ctx))
      return [{ s: 'nt', name: nt }]
    }
  }
}

export function compileGrammar(root: Matcher, registry: Registry): Grammar {
  const ctx: CompileCtx = { prods: new Map(), nextProdId: { n: 0 }, nameCounts: new Map() }
  const startBody = compileBody(root, ctx)
  const start = freshName(ctx, 'start')
  // Reorder so the start nonterminal is first in iteration (cosmetic).
  const reordered = new Map<string, Production[]>([[start, []]])
  for (const [k, v] of ctx.prods) reordered.set(k, v)
  ctx.prods = reordered
  addProd(ctx, start, startBody)
  return { start, prods: ctx.prods, registry }
}

// =====================================================================
// 2. FIRST / FOLLOW over CONCRETE-KEY columns
// =====================================================================
//
// Columns: concrete keys (incl. expanded group members and expanded digit
// columns), LIT_COL (wildcard), EPS_COL (nullability).

function firstColumnsOfSym(sym: Sym, g: Grammar, first: Map<string, Set<string>>): Set<string> {
  switch (sym.s) {
    case 'term':
      return new Set([sym.key])
    case 'digit':
      // Expand to CONCRETE digit columns: fresh offers 1-9, tail offers 0-9.
      return new Set(sym.tail ? DIGITS_TAIL : DIGITS_FRESH)
    case 'group': {
      const map = g.registry[sym.name]
      return new Set(map ? [...map.keys()] : [])
    }
    case 'lit':
      return new Set([LIT_COL])
    case 'nt':
      return new Set(first.get(sym.name) ?? [])
  }
}

function symIsNullable(sym: Sym, first: Map<string, Set<string>>): boolean {
  if (sym.s === 'nt') return (first.get(sym.name) ?? new Set()).has(EPS_COL)
  return false // term/digit/group/lit always consume a key
}

function computeFirst(g: Grammar): Map<string, Set<string>> {
  const first = new Map<string, Set<string>>()
  for (const nt of g.prods.keys()) first.set(nt, new Set())
  let changed = true
  while (changed) {
    changed = false
    for (const [nt, prods] of g.prods) {
      const set = first.get(nt)!
      for (const p of prods) {
        for (const c of firstOfBody(p.body, g, first)) {
          if (!set.has(c)) {
            set.add(c)
            changed = true
          }
        }
      }
    }
  }
  return first
}

function firstOfBody(body: Sym[], g: Grammar, first: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>()
  let nullablePrefix = true
  for (const sym of body) {
    for (const c of firstColumnsOfSym(sym, g, first)) {
      if (c !== EPS_COL) out.add(c)
    }
    if (!symIsNullable(sym, first)) {
      nullablePrefix = false
      break
    }
  }
  if (nullablePrefix) out.add(EPS_COL)
  return out
}

function computeFollow(g: Grammar, first: Map<string, Set<string>>): Map<string, Set<string>> {
  const follow = new Map<string, Set<string>>()
  for (const nt of g.prods.keys()) follow.set(nt, new Set())
  follow.get(g.start)!.add(EPS_COL) // end-of-input marker
  let changed = true
  while (changed) {
    changed = false
    for (const [nt, prods] of g.prods) {
      for (const p of prods) {
        for (let i = 0; i < p.body.length; i++) {
          const sym = p.body[i]
          if (sym.s !== 'nt') continue
          const target = follow.get(sym.name)!
          const firstRest = firstOfBody(p.body.slice(i + 1), g, first)
          for (const c of firstRest) {
            if (c !== EPS_COL && !target.has(c)) {
              target.add(c)
              changed = true
            }
          }
          if (firstRest.has(EPS_COL)) {
            for (const c of follow.get(nt)!) {
              if (!target.has(c)) {
                target.add(c)
                changed = true
              }
            }
          }
        }
      }
    }
  }
  return follow
}

// =====================================================================
// 3. Left-recursion detection
// =====================================================================
//
// Edge nt -> X if X is a leftmost nt reachable through a nullable prefix of some
// production of nt. A back edge in DFS is left recursion.

function detectLeftRecursion(g: Grammar, first: Map<string, Set<string>>): CompileError[] {
  const errors: CompileError[] = []
  const color = new Map<string, number>() // 0 white, 1 grey, 2 black
  for (const nt of g.prods.keys()) color.set(nt, 0)

  const visit = (nt: string): void => {
    color.set(nt, 1)
    for (const p of g.prods.get(nt)!) {
      for (const sym of p.body) {
        if (sym.s === 'nt') {
          const c = color.get(sym.name)
          if (c === 1) {
            errors.push({
              kind: 'left-recursion',
              nt: sym.name,
              message: `left recursion: ${sym.name} is reachable as a leftmost symbol from itself`,
            })
          } else if (c === 0) {
            visit(sym.name)
          }
        }
        if (!symIsNullable(sym, first)) break // can't extend left edge past a real terminal
      }
    }
    color.set(nt, 2)
  }
  for (const nt of g.prods.keys()) if (color.get(nt) === 0) visit(nt)

  const seen = new Set<string>()
  return errors.filter((e) => (seen.has(e.nt) ? false : (seen.add(e.nt), true)))
}

// =====================================================================
// 4. Table construction == admissibility check
// =====================================================================
//
// For each nonterminal N and production P:
//   for each column c in FIRST(P):           M[N,c] := P   (FIRST/FIRST check)
//   if P nullable: for each c in FOLLOW(N):   M[N,c] := P   (FIRST/FOLLOW check)
// A cell already holding a different production is a conflict.
//
// THE ONE SANCTIONED PRECEDENCE (greedy count, continue-over-exit): a count tail
// offers concrete digit columns 0-9 from its FIRST (continue), and the bare '0'
// motion / EPS exit may put a production in the SAME concrete '0' column via
// FOLLOW. At column '0', M[count-tail,'0'] receives `continue` (FIRST) and
// `exit` (FOLLOW). The greedy precedence PICKS CONTINUE at fill — one static
// entry, no runtime tie-break. (M[count-fresh,'0'] is unaffected: a fresh count
// offers only 1-9, so '0' there is the exit/0-motion.)

export function buildTable(g: Grammar): Table {
  const first = computeFirst(g)
  const follow = computeFollow(g, first)
  const errors: CompileError[] = [...detectLeftRecursion(g, first)]

  const M = new Map<string, Map<string, Production>>()
  const via = new Map<string, Map<string, 'first' | 'follow'>>()

  for (const [nt, prods] of g.prods) {
    const row = new Map<string, Production>()
    const rowVia = new Map<string, 'first' | 'follow'>()
    M.set(nt, row)
    via.set(nt, rowVia)
    const isCount = nt.startsWith('count')

    for (const p of prods) {
      const fb = firstOfBody(p.body, g, first)
      for (const c of fb) {
        if (c !== EPS_COL) place(nt, c, p, 'first', row, rowVia, errors, isCount)
      }
      if (fb.has(EPS_COL)) {
        for (const c of follow.get(nt)!) {
          place(nt, c, p, 'follow', row, rowVia, errors, isCount)
        }
      }
    }
  }

  if (errors.length) throw new AdmissibilityError(errors)
  return { grammar: g, M, first, follow }
}

function place(
  nt: string,
  column: string,
  p: Production,
  how: 'first' | 'follow',
  row: Map<string, Production>,
  rowVia: Map<string, 'first' | 'follow'>,
  errors: CompileError[],
  isCount: boolean,
): void {
  const existing = row.get(column)
  if (!existing || existing.id === p.id) {
    row.set(column, p)
    rowVia.set(column, how)
    return
  }
  const prevHow = rowVia.get(column)!

  // Sanctioned continue-over-exit for the greedy count nonterminal only: the
  // FIRST production (continue) beats the FOLLOW production (exit) at fill. This
  // is the lone documented exception to FIRST-disjointness; it produces a single
  // static cell with no runtime tie-break.
  if (isCount && prevHow !== how) {
    if (how === 'first') {
      row.set(column, p)
      rowVia.set(column, 'first')
    }
    return
  }

  if (prevHow === 'first' && how === 'first') {
    errors.push({
      kind: 'first-first',
      nt,
      column,
      prods: [existing.id, p.id],
      message: `FIRST/FIRST conflict in ${nt} at column '${colName(column)}': productions ${existing.id} and ${p.id} both start with this terminal`,
    })
  } else {
    const nullableProd = prevHow === 'follow' ? existing.id : p.id
    const otherProd = prevHow === 'follow' ? p.id : existing.id
    errors.push({
      kind: 'first-follow',
      nt,
      column,
      prods: [nullableProd, otherProd],
      message: `FIRST/FOLLOW conflict in ${nt} at column '${colName(column)}': nullable production ${nullableProd}'s FOLLOW meets FIRST of production ${otherProd}`,
    })
  }
}

/** Human-readable column name (the special columns get angle-bracket labels). */
export function colName(c: string): string {
  if (c === LIT_COL) return '<any>'
  if (c === EPS_COL) return '<eof>'
  return c
}
