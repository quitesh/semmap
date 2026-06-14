/**
 * Bundled vim grammar fragment for {@link @quitesh/semmap!KeyboardEngine}.
 *
 * Exposes {@link vimGrammar}, which returns the engine-relevant vim primitives
 * (motions, operators, simple commands, mode entries) as plain keymaps for
 * consumers to compose their own modes and scopes around. Import via
 * `@quitesh/semmap/presets/vim`.
 *
 * @module
 */
import type { BindingEntry, Keymap } from '../keyboard/keymap.js'

/**
 * Bare vim grammar fragments. Returns the engine-relevant primitives only:
 * motions, operators, simple commands, and basic navigation. The consumer
 * composes modes / scopes around these (typically overlaying app-specific
 * action bindings on top).
 *
 * Three keymaps:
 *
 * - `normal` — motions, operators, simple commands, and i/a/I/A entries to
 *   insert mode (emitted as `vim.enterInsert` by default).
 * - `insert` — only the `Escape` → `vim.enterNormal` binding; the consumer
 *   layers its own typing/editing keys on top.
 * - `opPending` — alias of `normal`'s motion subset for operator-pending
 *   resolution. The engine snapshots the source keymap as the motion overlay
 *   when an operator fires, so this is provided for tests and explicit
 *   composition; consumers typically don't need to wire it directly.
 */
export function vimGrammar(): { normal: Keymap; insert: Keymap; opPending: Keymap } {
  const normal: Keymap = new Map<string, BindingEntry>([
    // Mode entries
    ['i', { type: 'action', action: 'vim.enterInsert' }],
    ['a', { type: 'action', action: 'vim.enterInsert' }],
    ['I', { type: 'action', action: 'vim.enterInsert' }],
    ['A', { type: 'action', action: 'vim.enterInsert' }],

    // Motions
    ['h', { type: 'motion', motion: 'h' }],
    ['l', { type: 'motion', motion: 'l' }],
    ['w', { type: 'motion', motion: 'w' }],
    ['b', { type: 'motion', motion: 'b' }],
    ['e', { type: 'motion', motion: 'e' }],
    ['0', { type: 'motion', motion: '0' }],
    ['$', { type: 'motion', motion: '$' }],
    ['^', { type: 'motion', motion: '^' }],

    // Operators (engine consumes these via operatorActions option)
    ['d', { type: 'operator', operator: 'd' }],
    ['c', { type: 'operator', operator: 'c' }],
    ['y', { type: 'operator', operator: 'y' }],

    // Simple commands
    ['x', { type: 'action', action: 'vim.deleteChar' }],
    ['p', { type: 'action', action: 'vim.paste' }],
    ['P', { type: 'action', action: 'vim.pasteBefore' }],
    ['u', { type: 'action', action: 'vim.undo' }],
    ['C-r', { type: 'action', action: 'vim.redo' }],

    // Navigation
    ['j', { type: 'action', action: 'action.down' }],
    ['k', { type: 'action', action: 'action.up' }],
  ])

  const insert: Keymap = new Map<string, BindingEntry>([
    ['Escape', { type: 'action', action: 'vim.enterNormal' }],
  ])

  // opPending is the motion subset of normal; included for tests / explicit
  // composition. The engine snapshots the source keymap as overlay at the
  // moment an operator fires, so consumers using `normal` directly get the
  // correct behaviour without referencing opPending.
  const opPending: Keymap = new Map<string, BindingEntry>([
    ['h', { type: 'motion', motion: 'h' }],
    ['l', { type: 'motion', motion: 'l' }],
    ['w', { type: 'motion', motion: 'w' }],
    ['b', { type: 'motion', motion: 'b' }],
    ['e', { type: 'motion', motion: 'e' }],
    ['0', { type: 'motion', motion: '0' }],
    ['$', { type: 'motion', motion: '$' }],
    ['^', { type: 'motion', motion: '^' }],
  ])

  return { normal, insert, opPending }
}
