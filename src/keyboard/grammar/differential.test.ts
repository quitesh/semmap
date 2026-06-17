/**
 * Differential oracle: run the SAME vim case list through the independent
 * reference tree-interpreter (the oracle) and the production compiled core, and
 * assert deep-equal status/Command. The tree-interpreter is the ground truth the
 * compiled path must match byte-identically.
 */

import { describe, expect, it } from 'vitest'

// The reference tree-interpreter (oracle), kept as an independent implementation
// for differential testing.
import {
  type Recognizer,
  type StepResult as TreeStepResult,
  initialState as treeInit,
  makeRecognizer,
  step as treeStep,
} from './__testsupport__/referenceInterpreter.js'

// The production compiled core + the shared vim grammar fixture.
import { buildTable, compileGrammar } from './compile.js'
import { type ParseState, type StepResult, initialState, step } from './step.js'
import { vimGrammar, vimRegistry } from './vimFixture.js'

const table = buildTable(compileGrammar(vimGrammar, vimRegistry))
const vimRecognizer = makeRecognizer(vimGrammar, vimRegistry)

function runCompiled(keys: string[]): StepResult {
  let state: ParseState = initialState(table)
  let result: StepResult = { status: 'pending', state }
  for (const k of keys) {
    result = step(table, state, k)
    state = result.state
  }
  return result
}

function runTree(rec: Recognizer, keys: string[]): TreeStepResult {
  let state = treeInit(rec)
  let result: TreeStepResult = { status: 'pending', state }
  for (const k of keys) {
    result = treeStep(rec, state, k)
    state = result.state
  }
  return result
}

const CASES: string[][] = [
  ['w'],
  ['2', 'w'],
  ['d', 'w'],
  ['2', 'd', 'w'],
  ['d', '2', 'w'],
  ['2', 'd', '3', 'w'],
  ['d', 'd'],
  ['2', 'd', 'd'],
  ['c', 'c'],
  ['y', 'y'],
  ['x'],
  ['2', 'x'],
  ['d', 'i', 'w'],
  ['d', 'a', 'p'],
  ['d', 'f', 'x'],
  // count multiplication + the 0-rule
  ['0'],
  ['1', '0', 'w'],
  ['d', '0'],
  ['d', '1', '0', 'w'],
  // dead-ends
  ['z'],
  ['d', 'z'],
  ['d', 'Escape'],
  // pending partials
  ['d'],
  ['2'],
  ['d', '2'],
]

describe('differential: compiled core vs tree-interpreter oracle', () => {
  for (const keys of CASES) {
    it(`'${keys.join('')}' matches the oracle`, () => {
      const tree = runTree(vimRecognizer, keys)
      const compiled = runCompiled(keys)
      expect(compiled.status).toBe(tree.status)
      if (tree.status === 'resolved' && compiled.status === 'resolved') {
        expect(compiled.command).toEqual(tree.command)
      }
    })
  }
})

describe('compiled core: explicit resolved commands', () => {
  const resolved = (keys: string[]) => {
    const r = runCompiled(keys)
    expect(r.status).toBe('resolved')
    if (r.status !== 'resolved') throw new Error('not resolved')
    return r.command
  }

  it('w', () => expect(resolved(['w'])).toEqual({ motion: { id: 'motion.word' } }))
  it('2w', () => expect(resolved(['2', 'w'])).toEqual({ count: 2, motion: { id: 'motion.word' } }))
  it('dw', () =>
    expect(resolved(['d', 'w'])).toEqual({
      operator: 'operator.delete',
      motion: { id: 'motion.word' },
    }))
  it('2d3w -> count 6', () =>
    expect(resolved(['2', 'd', '3', 'w'])).toEqual({
      count: 6,
      operator: 'operator.delete',
      motion: { id: 'motion.word' },
    }))
  it('dd linewise', () =>
    expect(resolved(['d', 'd'])).toEqual({ operator: 'operator.delete', linewise: true }))
  it('cc linewise', () =>
    expect(resolved(['c', 'c'])).toEqual({ operator: 'operator.change', linewise: true }))
  it('yy linewise', () =>
    expect(resolved(['y', 'y'])).toEqual({ operator: 'operator.yank', linewise: true }))
  it('x action', () => expect(resolved(['x'])).toEqual({ action: 'action.delete-char' }))
  it('2x action', () =>
    expect(resolved(['2', 'x'])).toEqual({ count: 2, action: 'action.delete-char' }))
  it('diw', () =>
    expect(resolved(['d', 'i', 'w'])).toEqual({
      operator: 'operator.delete',
      textObject: { scope: 'i', id: 'word' },
    }))
  it('dap', () =>
    expect(resolved(['d', 'a', 'p'])).toEqual({
      operator: 'operator.delete',
      textObject: { scope: 'a', id: 'paragraph' },
    }))
  it('dfx wildcard literal', () =>
    expect(resolved(['d', 'f', 'x'])).toEqual({
      operator: 'operator.delete',
      motion: { id: 'motion.find', arg: 'x' },
    }))
  it('10w count 10 (0-rule mid-count)', () =>
    expect(resolved(['1', '0', 'w'])).toEqual({ count: 10, motion: { id: 'motion.word' } }))
  it('0 fresh -> bol motion', () =>
    expect(resolved(['0'])).toEqual({ motion: { id: 'motion.bol' } }))
  it('d0 -> delete to bol', () =>
    expect(resolved(['d', '0'])).toEqual({
      operator: 'operator.delete',
      motion: { id: 'motion.bol' },
    }))
  it('d10w -> count2 10, delete word', () =>
    expect(resolved(['d', '1', '0', 'w'])).toEqual({
      count: 10,
      operator: 'operator.delete',
      motion: { id: 'motion.word' },
    }))
})

describe('compiled core: dead-end policy', () => {
  it('fresh unbound key -> unmatched (yield)', () =>
    expect(runCompiled(['z']).status).toBe('unmatched'))
  it('mid-parse dead end -> cancelled (eat)', () =>
    expect(runCompiled(['d', 'z']).status).toBe('cancelled'))
  it('Escape mid-parse -> cancelled', () =>
    expect(runCompiled(['d', 'Escape']).status).toBe('cancelled'))
  it('partials stay pending', () => {
    expect(runCompiled(['d']).status).toBe('pending')
    expect(runCompiled(['2']).status).toBe('pending')
    expect(runCompiled(['d', '2']).status).toBe('pending')
  })
})
