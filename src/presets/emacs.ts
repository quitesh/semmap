/**
 * Bundled emacs grammar fragment for {@link @quitesh/semmap!KeyboardEngine}.
 *
 * Exposes {@link emacsGrammar}, which returns the engine-relevant emacs
 * primitives (the `C-u` universal-argument binding, a `C-x` prefix scaffold,
 * and universal motion / cancel keys) for consumers to layer their own action
 * catalog on top of. Import via `@quitesh/semmap/presets/emacs`.
 *
 * @module
 */
import type { BindingEntry, Keymap } from '../keyboard/keymap.js'
import { Actions } from '../keyboardEngine.js'

/**
 * Bare emacs grammar fragment. Returns the engine-relevant primitives only:
 * the `C-u` universal-argument binding, the `C-x` prefix scaffold (consumers
 * fill in the continuation), and universal motion / cancel keys.
 *
 * Quite-app and other consumers layer their full action catalog on top — the
 * library does not ship a complete emacs keymap.
 */
export function emacsGrammar(): Keymap {
  // Empty C-x continuation; consumers populate it with their own bindings.
  const cxContinuation: Keymap = new Map<string, BindingEntry>()

  const km: Keymap = new Map<string, BindingEntry>([
    // Universal argument (emits the engine-recognised default; consumers
    // overriding `universalArgAction` should emit their own id here).
    ['C-u', { type: 'action', action: Actions.UNIVERSAL_ARG }],

    // C-x prefix scaffold; consumers append to `cxContinuation` to extend it.
    ['C-x', { type: 'prefix', keymap: cxContinuation }],

    // Universal cancel / motion keys
    ['C-g', { type: 'action', action: 'action.cancel' }],
    ['Escape', { type: 'action', action: 'action.cancel' }],
    ['C-a', { type: 'action', action: 'action.beginningOfLine' }],
    ['C-e', { type: 'action', action: 'action.endOfLine' }],
    ['C-f', { type: 'action', action: 'action.forwardChar' }],
    ['C-b', { type: 'action', action: 'action.backwardChar' }],
    ['C-n', { type: 'action', action: 'action.down' }],
    ['C-p', { type: 'action', action: 'action.up' }],
  ])

  return km
}
