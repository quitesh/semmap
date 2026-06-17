/**
 * Test-only vim grammar fixture, built from the neutral combinators. This lives
 * here so the grammar tests can exercise the full combinator set (operators,
 * motions, groups, literals, text objects, doubling) without the core knowing
 * any vim. The differential oracle (`__testsupport__/referenceInterpreter.ts`)
 * runs over this same grammar so the compiled core and the reference
 * interpreter compare like for like. NOT production code — no vim knowledge
 * belongs in the core modules.
 */

import { choice, count, group, key, literal, type Eff, type Matcher, type Registry, seq } from './matcher.js'

const operators = new Map<string, Eff>([
  ['d', { kind: 'operator', id: 'operator.delete' }],
  ['c', { kind: 'operator', id: 'operator.change' }],
  ['y', { kind: 'operator', id: 'operator.yank' }],
])

const motions = new Map<string, Eff>([
  ['w', { kind: 'motion', id: 'motion.word' }],
  ['b', { kind: 'motion', id: 'motion.back' }],
  ['e', { kind: 'motion', id: 'motion.end' }],
  ['h', { kind: 'motion', id: 'motion.left' }],
  ['l', { kind: 'motion', id: 'motion.right' }],
  ['0', { kind: 'motion', id: 'motion.bol' }],
  ['$', { kind: 'motion', id: 'motion.eol' }],
])

const actions = new Map<string, Eff>([['x', { kind: 'action', id: 'action.delete-char' }]])

const objects = new Map<string, Eff>([
  ['w', { kind: 'to-object', id: 'word' }],
  ['p', { kind: 'to-object', id: 'paragraph' }],
])

export const vimRegistry: Registry = {
  operator: operators,
  motion: motions,
  action: actions,
  object: objects,
}

const textobject: Matcher = seq(
  choice(key('i', { kind: 'to-scope', scope: 'i' }), key('a', { kind: 'to-scope', scope: 'a' })),
  group('object'),
)

const find: Matcher = seq(
  key('f', { kind: 'find-marker', id: 'motion.find' }),
  literal({ kind: 'find-arg' }),
)

const target: Matcher = choice(group('motion'), textobject, find)

function operatorClause(opKey: string, opEff: Eff): Matcher {
  return seq(key(opKey, opEff), count(), choice(target, key(opKey, { kind: 'linewise' })))
}

export function operatorPending(ops: Map<string, Eff>): Matcher {
  const clauses: Matcher[] = []
  for (const [opKey, opEff] of ops) clauses.push(operatorClause(opKey, opEff))
  return seq(count(), choice(...clauses, group('motion'), group('action')))
}

export const vimGrammar: Matcher = operatorPending(operators)
