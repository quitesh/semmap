/**
 * The keymap→grammar bridge: "the grammar is the keymap" made concrete. Compiles
 * a flat keymap (plus the leading-count and universal-argument flags) into a
 * neutral combinator grammar + registry, then into an LL(1) table (cached).
 *
 * Scope for slice 1a: `BindingEntry` kinds `action` and `passthrough` become
 * terminals; the binding whose action id equals `universalArgAction` is routed
 * into the {@link prefixArg} productions instead of a plain action. When
 * `acceptsLeadingCount` is set, the command is wrapped in a leading {@link count}.
 * `operator` / `motion` / `prefix` are 1b/1c — encountering one throws.
 *
 * Resolution order mirrors the live engine: keymaps are walked top-of-stack
 * first and the FIRST binding for a key wins (later/lower bindings for the same
 * key are shadowed), exactly like `KeyboardEngine.resolveKey`'s top-down walk.
 */

import type { BindingEntry } from '../../modeRegistry.js'
import { buildTable, compileGrammar, type Table } from './compile.js'
import { choice, count, key, type Matcher, type Registry, seq } from './matcher.js'
import { prefixArg } from './presets/prefixArg.js'

export interface KeymapGrammarInput {
  /** Active keymaps, top-of-stack first (the FIRST binding per key wins). */
  keymaps: Iterable<Map<string, BindingEntry>>
  /** Whether a leading digit count is accepted (vim-normal/visual). */
  acceptsLeadingCount: boolean
  /** The action id whose binding drives universal-argument accumulation. */
  universalArgAction: string
  /** Canonical key that flips the universal-argument sign (default `'-'`). */
  signKey?: string
}

export interface KeymapGrammarResult {
  grammar: ReturnType<typeof compileGrammar>
  table: Table
  registry: Registry
}

/**
 * Flatten the keymap stack to the effective top-down binding per key, then build
 * the grammar + compiled table.
 */
export function keymapGrammar(input: KeymapGrammarInput): KeymapGrammarResult {
  const { acceptsLeadingCount, universalArgAction } = input
  const signKey = input.signKey ?? '-'

  // Top-down flatten: first binding per key wins (matches resolveKey's walk).
  const flat = new Map<string, BindingEntry>()
  for (const km of input.keymaps) {
    for (const [k, entry] of km) {
      if (!flat.has(k)) flat.set(k, entry)
    }
  }

  // Build the command alternatives. The uarg binding becomes prefixArg; every
  // other action/passthrough binding becomes a terminal.
  const terminals: Matcher[] = []
  let uargKey: string | null = null
  for (const [k, entry] of flat) {
    switch (entry.type) {
      case 'action':
        if (entry.action === universalArgAction) {
          if (uargKey !== null) {
            throw new Error(
              `keymapGrammar: universal-argument action '${universalArgAction}' bound to multiple keys ('${uargKey}', '${k}'); 1a supports a single uarg key`,
            )
          }
          uargKey = k
        } else {
          terminals.push(key(k, { kind: 'action', id: entry.action }))
        }
        break
      case 'passthrough':
        terminals.push(key(k, { kind: 'passthrough' }))
        break
      case 'operator':
      case 'motion':
      case 'prefix':
        throw new Error(
          `keymapGrammar: BindingEntry kind '${entry.type}' (key '${k}') unsupported in slice 1a; the bridge learns operators/motions/prefixes in 1b/1c`,
        )
    }
  }

  // The command nonterminal: one terminal must match for the command to resolve.
  const command: Matcher =
    terminals.length === 1 ? terminals[0] : choice(...terminals)

  // Compose the prefix paradigm. acceptsLeadingCount and universal-argument are
  // mutually exclusive in practice (counting contexts don't bind C-u), but the
  // bridge keeps them independent: a leading count wraps the command; a uarg key
  // routes into prefixArg, whose nullable productions sit before the command.
  let root: Matcher
  if (uargKey !== null) {
    root = seq(prefixArg(uargKey, signKey), command)
  } else if (acceptsLeadingCount) {
    root = seq(count(), command)
  } else {
    root = command
  }

  const grammar = compileGrammar(root, {} as Registry)
  const table = buildTable(grammar)
  return { grammar, table, registry: grammar.registry }
}
