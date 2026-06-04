import type { KeymapActionId } from './keymap.js'
import type { ActionArgs, ScopeStack } from './scopeStack.js'

/**
 * What the engine produces for a key event. The dispatcher consumes
 * this union; `EngineResult` itself is defined in `keyboardEngine.ts`,
 * but the dispatcher needs a structural view.
 */
export interface EngineResultLike {
  type:
    | 'action'
    | 'passthrough'
    | 'pending'
    | 'unmatched'
    | 'composing'
    | 'chordCancelled'
  action?: KeymapActionId
  motion?: string
  count?: number
}

/**
 * Routes engine results.
 *
 * - `action` → walk-remap from a semantic/keymap action to a concrete handler
 *   action, then walk the scope stack for the first handler that returns
 *   `true`. Returns whether any handler claimed the action. Vim operators
 *   (vim.delete, vim.change, vim.yank) arrive here as normal actions with
 *   motion/count args.
 * - `passthrough` / `pending` / `unmatched` / `composing` / `chordCancelled`
 *   → no side effect; returns `false`. Capture-phase listener uses the return
 *   value to decide `preventDefault`. The consumer is responsible for any
 *   passthrough-specific routing (e.g. terminal re-dispatch) based on the
 *   active focus context.
 */
export class Dispatcher {
  constructor(private stack: ScopeStack) {}

  dispatch(result: EngineResultLike, _e: KeyboardEvent): boolean {
    switch (result.type) {
      case 'action': {
        if (!result.action) return false
        const final = this.stack.walkRemap(result.action)
        const args: ActionArgs = {}
        if (result.count !== undefined) args.count = result.count
        if (result.motion !== undefined) args.motion = result.motion
        return this.stack.walkHandler(final, args)
      }
      default:
        return false
    }
  }
}
