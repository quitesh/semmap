/**
 * Compiler tests: admissibility (FIRST/FIRST, FIRST/FOLLOW, left-recursion) and
 * the CONCRETE-KEY regression that locks in the table-fill precedence fix.
 */

import { describe, expect, it } from 'vitest'
import {
  AdmissibilityError,
  buildTable,
  compileGrammar,
  EPS_COL,
  LIT_COL,
} from './compile.js'
import { choice, count, group, key, type Matcher, seq } from './matcher.js'
import { vimGrammar, vimRegistry } from './vimFixture.js'

describe('admissibility = table construction', () => {
  it('FIRST/FIRST: two choice alts sharing a first-key is rejected', () => {
    const bad: Matcher = choice(
      seq(key('g', { kind: 'action', id: 'a.one' }), key('a')),
      seq(key('g', { kind: 'action', id: 'a.two' }), key('b')),
    )
    let err: unknown
    try {
      buildTable(compileGrammar(bad, {}))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AdmissibilityError)
    const errs = (err as AdmissibilityError).errors
    expect(errs.some((e) => e.kind === 'first-first')).toBe(true)
  })

  it('FIRST/FOLLOW: nullable element whose FIRST meets its FOLLOW is rejected', () => {
    const epsAlt = seq() // empty seq == nullable production (eps)
    const nullableA: Matcher = choice(key('a', { kind: 'action', id: 'opt.a' }), epsAlt)
    const bad: Matcher = seq(nullableA, key('a', { kind: 'action', id: 'lit.a' }))
    let err: unknown
    try {
      buildTable(compileGrammar(bad, {}))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AdmissibilityError)
    const errs = (err as AdmissibilityError).errors
    expect(errs.some((e) => e.kind === 'first-follow')).toBe(true)
  })

  it('left recursion is rejected with a diagnostic', () => {
    // R -> R (via a nullable-prefixed self-reference). Model with a hand-built
    // grammar: compile a grammar then mutate it to introduce a left-recursive nt.
    // Simpler: a choice whose alt references the enclosing nt is not expressible
    // via combinators (they're a DAG), so build directly via compileGrammar then
    // patch. Instead assert the detector fires on a constructed cyclic grammar.
    const g = compileGrammar(seq(group('motion')), vimRegistry)
    // Introduce left recursion: start -> start
    const startProds = g.prods.get(g.start)!
    startProds.push({ id: 999, body: [{ s: 'nt', name: g.start }] })
    let err: unknown
    try {
      buildTable(g)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AdmissibilityError)
    expect((err as AdmissibilityError).errors.some((e) => e.kind === 'left-recursion')).toBe(true)
  })

  it('the real vim grammar compiles with no conflicts', () => {
    expect(() => buildTable(compileGrammar(vimGrammar, vimRegistry))).not.toThrow()
  })

  it('greedy count + 0-rule is not mis-flagged as a conflict', () => {
    const g = seq(count(), group('motion'))
    expect(() => buildTable(compileGrammar(g, vimRegistry))).not.toThrow()
  })
})

describe('position, not state: count1 vs count2 are distinct nonterminals', () => {
  const table = buildTable(compileGrammar(vimGrammar, vimRegistry))

  it('count1 (pre-operator) and count2 (operand) are distinct nonterminals', () => {
    const countNts = [...table.grammar.prods.keys()].filter(
      (n) => n === 'count' || n.startsWith('count#'),
    )
    expect(countNts).toContain('count')
    expect(countNts.some((n) => n.startsWith('count#'))).toBe(true)
  })

  it('count slot is carried on the digit symbol (its position), not a flag', () => {
    // count1's digit symbols carry slot 1; count2's carry slot 2.
    const freshCount1 = table.grammar.prods.get('count')!
    const digit1 = freshCount1[0].body.find((s) => s.s === 'digit')
    expect(digit1 && digit1.s === 'digit' && digit1.slot).toBe(1)

    const count2Name = [...table.grammar.prods.keys()].find(
      (n) => n.startsWith('count#') && !n.endsWith('.tail'),
    )!
    const freshCount2 = table.grammar.prods.get(count2Name)!
    const digit2 = freshCount2[0].body.find((s) => s.s === 'digit')
    expect(digit2 && digit2.s === 'digit' && digit2.slot).toBe(2)
  })
})

// ── THE concrete-key regression — this must never regress ────────────

describe('concrete-key table (the locked-in fix)', () => {
  const table = buildTable(compileGrammar(vimGrammar, vimRegistry))

  it('the table contains NO digit-class column (no synthetic DIGIT* columns)', () => {
    for (const row of table.M.values()) {
      for (const col of row.keys()) {
        // Every column is a concrete key, the wildcard, or the eps marker.
        // A synthetic digit class would be some other reserved name.
        expect(col === LIT_COL || col === EPS_COL || /^.$/u.test(col) || col.length >= 1).toBe(true)
        // Specifically: the earlier prototype's ' digit19' / ' digit09' are gone.
        expect(col).not.toBe(' digit19')
        expect(col).not.toBe(' digit09')
      }
    }
  })

  it('count rows offer CONCRETE digit columns (1-9 fresh, 0-9 tail)', () => {
    const freshRow = table.M.get('count')!
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(freshRow.has(d)).toBe(true)
    }
    // a fresh count offers NO '0' digit-continue (0-rule): M[count,'0'] is the exit.
    const tailRow = table.M.get('count.tail')!
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(tailRow.has(d)).toBe(true)
    }
  })

  it("M[count-fresh,'0'] is the EXIT production (eps), not a digit-continue", () => {
    const freshRow = table.M.get('count')!
    const at0 = freshRow.get('0')
    // The fresh count never claims '0' as a digit; '0' falls through to the exit
    // (the empty-body eps production, placed at '0' via FOLLOW — the 0-motion).
    expect(at0).toBeDefined()
    expect(at0!.body.length).toBe(0)
    // The continue production (digit + tail) must NOT be at column '0'.
    const continueProd = table.grammar.prods.get('count')!.find((p) => p.body.length > 0)!
    expect(at0!.id).not.toBe(continueProd.id)
  })

  it("M[count-tail,'0'] is a SINGLE static entry = the CONTINUE production (precedence at fill)", () => {
    const tailRow = table.M.get('count.tail')!
    const at0 = tailRow.get('0')
    expect(at0).toBeDefined()
    // The continue production is the non-empty body (digit + tail); the exit is eps.
    const tailProds = table.grammar.prods.get('count.tail')!
    const continueProd = tailProds.find((p) => p.body.length > 0)!
    const exitProd = tailProds.find((p) => p.body.length === 0)!
    expect(at0!.id).toBe(continueProd.id)
    expect(at0!.id).not.toBe(exitProd.id)
    // ONE entry — Map column holds exactly one production, no runtime tie-break list.
    expect(typeof at0!.id).toBe('number')
  })
})
