/**
 * Physical-key string normalized by `normalizeKeyEvent` — e.g. "a",
 * "Enter", "C-x", "M-S-T", "s-ArrowUp".
 */
export type KeyStr = string

/** Generic action id. Prefer narrower aliases at keyboard routing boundaries. */
export type ActionId = string

export type SemanticInputActionId =
  | 'input.complete'
  | 'input.completeCycleBack'
  | 'input.deleteCharBack'

/**
 * Semantic/abstract action id emitted by keymaps before remap —
 * `action.up`, `action.submit`, `action.cancel`, `input.complete`, …
 */
export type SemanticActionId = `action.${string}` | SemanticInputActionId | `motion:${string}`

export function isSemanticActionId(action: ActionId): action is SemanticActionId {
  if (!action) return false
  return (
    action.startsWith('action.') ||
    action.startsWith('motion:') ||
    action === 'input.complete' ||
    action === 'input.completeCycleBack' ||
    action === 'input.deleteCharBack'
  )
}

/**
 * Action id produced by a keymap entry. Prefer semantic ids for user-facing
 * bindings; some app/global keymaps intentionally emit concrete ids directly.
 */
export type KeymapActionId = ActionId

/**
 * Concrete action id consumed by scope handlers after dispatcher remapping —
 * `modal.close`, `form.submit`, `palette.select`, …
 */
export type HandlerActionId = ActionId

/** Semantic action -> concrete handler action routing table. */
export type ActionRemap = ReadonlyMap<ActionId, HandlerActionId>

export interface SemanticActionRemaps {
  remaps: ActionRemap
}

export function defineSemanticActionRemaps(
  entries: readonly (readonly [SemanticActionId, HandlerActionId])[],
): SemanticActionRemaps {
  return {
    remaps: new Map<ActionId, HandlerActionId>(entries),
  }
}

/**
 * What a keymap entry produces when its key resolves.
 *
 * - `action` — emit a (typically abstract) action id; the dispatcher
 *   then walks the scope stack for remap + handler.
 * - `operator` / `motion` — vim grammar; the engine pushes / consumes
 *   the operator-pending overlay (engine-internal state).
 * - `prefix` — chord prefix; the engine captures the inline
 *   continuation keymap and waits for the next key.
 * - `passthrough` — the engine yields the key; the consumer decides
 *   what to do based on focus / active scope.
 */
export type BindingEntry =
  | { type: 'action'; action: KeymapActionId }
  | { type: 'operator'; operator: string }
  | { type: 'motion'; motion: string }
  | { type: 'prefix'; keymap: Keymap }
  | { type: 'passthrough' }

/**
 * `key → BindingEntry`. Replaces the old `Mode` type from
 * `modeRegistry.ts` (no `defaultAction`, no `id`, no `type` field —
 * just the binding table).
 */
export type Keymap = Map<KeyStr, BindingEntry>
