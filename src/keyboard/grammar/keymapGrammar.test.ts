/**
 * Unit coverage for the keymap→grammar bridge, the `star` greedy repeat, and the
 * `prefixArg` preset — the pieces the differential harness exercises end-to-end
 * but that deserve direct, isolated assertions too.
 */

import { describe, expect, it } from 'vitest'
import { AdmissibilityError, buildTable, compileGrammar } from './compile.js'
import { keymapGrammar } from './keymapGrammar.js'
import { key, seq, star } from './matcher.js'
import { prefixArg } from './presets/prefixArg.js'
import { initialState, step } from './step.js'
import type { BindingEntry } from '../../modeRegistry.js'

const UARG = 'action.universalArgument'

describe('star: greedy repeat combinator', () => {
  it('compiles a disjoint-alternative star and repeats greedily', () => {
    // (a[+x] | b[+y])* then end-marker `;`
    const g = seq(
      star(
        key('a', { kind: 'action', id: 'a.x' }),
        key('b', { kind: 'motion', id: 'm.y' }),
      ),
      key(';', { kind: 'action', id: 'a.done' }),
    )
    const table = buildTable(compileGrammar(g, {}))
    let s = initialState(table)
    for (const k of ['a', 'b', 'a']) {
      const r = step(table, s, k)
      expect(r.status).toBe('pending')
      s = r.state
    }
    const fin = step(table, s, ';')
    expect(fin.status).toBe('resolved')
  })

  it('rejects a star whose alternatives share a FIRST key', () => {
    const bad = star(
      key('a', { kind: 'action', id: 'one' }),
      key('a', { kind: 'action', id: 'two' }),
    )
    expect(() => buildTable(compileGrammar(bad, {}))).toThrow(AdmissibilityError)
  })
})

describe('prefixArg preset', () => {
  it('compiles standalone (nullable: no C-u resolves the trailing action)', () => {
    const g = seq(prefixArg('C-u'), key('a', { kind: 'action', id: 'act.a' }))
    const table = buildTable(compileGrammar(g, {}))
    // bare `a` (no prefix) resolves with no count
    const r = step(table, initialState(table), 'a')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.command).toEqual({ action: 'act.a' })
  })

  it('C-u then a -> count 4', () => {
    const g = seq(prefixArg('C-u'), key('a', { kind: 'action', id: 'act.a' }))
    const table = buildTable(compileGrammar(g, {}))
    let s = initialState(table)
    s = step(table, s, 'C-u').state
    const r = step(table, s, 'a')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.command).toEqual({ count: 4, action: 'act.a' })
  })
})

describe('keymapGrammar bridge', () => {
  it('routes the universal-argument binding into prefixArg', () => {
    const map = new Map<string, BindingEntry>([
      ['C-u', { type: 'action', action: UARG }],
      ['a', { type: 'action', action: 'act.a' }],
    ])
    const { table } = keymapGrammar({
      keymaps: [map],
      acceptsLeadingCount: false,
      universalArgAction: UARG,
    })
    let s = initialState(table)
    s = step(table, s, 'C-u').state
    s = step(table, s, 'C-u').state
    const r = step(table, s, 'a')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.command).toEqual({ count: 16, action: 'act.a' })
  })

  it('wraps the command in a leading count when acceptsLeadingCount', () => {
    const map = new Map<string, BindingEntry>([['x', { type: 'action', action: 'act.x' }]])
    const { table } = keymapGrammar({
      keymaps: [map],
      acceptsLeadingCount: true,
      universalArgAction: UARG,
    })
    let s = initialState(table)
    s = step(table, s, '2').state
    s = step(table, s, '3').state
    const r = step(table, s, 'x')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.command).toEqual({ count: 23, action: 'act.x' })
  })

  it('compiles a passthrough binding to a passthrough terminal', () => {
    const map = new Map<string, BindingEntry>([['C-c', { type: 'passthrough' }]])
    const { table } = keymapGrammar({
      keymaps: [map],
      acceptsLeadingCount: false,
      universalArgAction: UARG,
    })
    const r = step(table, initialState(table), 'C-c')
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.command).toEqual({ passthrough: true })
  })

  it('top-down flatten: first binding per key wins', () => {
    const top = new Map<string, BindingEntry>([['a', { type: 'action', action: 'top.a' }]])
    const bottom = new Map<string, BindingEntry>([['a', { type: 'action', action: 'bottom.a' }]])
    const { table } = keymapGrammar({
      keymaps: [top, bottom],
      acceptsLeadingCount: false,
      universalArgAction: UARG,
    })
    const r = step(table, initialState(table), 'a')
    if (r.status === 'resolved') expect(r.command.action).toBe('top.a')
  })

  it('throws a clear error for operator/motion/prefix in 1a', () => {
    const map = new Map<string, BindingEntry>([['d', { type: 'operator', operator: 'delete' }]])
    expect(() =>
      keymapGrammar({ keymaps: [map], acceptsLeadingCount: true, universalArgAction: UARG }),
    ).toThrow(/unsupported in slice 1a/)
  })
})
