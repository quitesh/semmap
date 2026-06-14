/**
 * Physical-key string normalized by `normalizeKeyEvent` — e.g. "a",
 * "Enter", "C-x", "M-S-T", "s-ArrowUp".
 */
export type KeyStr = string

/** Generic action id. Prefer narrower aliases at keyboard routing boundaries. */
export type ActionId = string

/**
 * The fixed-string semantic action ids for text-input editing. Kept as a
 * separate union so {@link SemanticActionId} can accept them alongside the
 * open-ended `action.*` / `motion:*` template-literal forms.
 */
export type SemanticInputActionId =
  | 'input.complete'
  | 'input.completeCycleBack'
  | 'input.deleteCharBack'

/**
 * Semantic/abstract action id emitted by keymaps before remap —
 * `action.up`, `action.submit`, `action.cancel`, `input.complete`, …
 */
export type SemanticActionId = `action.${string}` | SemanticInputActionId | `motion:${string}`

/**
 * Type guard: true when `action` is a {@link SemanticActionId} (an `action.*`
 * or `motion:*` id, or one of the fixed `input.*` ids) rather than a concrete
 * handler action. Use it to decide whether an id still needs remapping.
 */
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

/** A built bundle of semantic-action remaps, ready to attach to a scope's `remaps`. */
export interface SemanticActionRemaps {
  /** Semantic action → concrete handler action routing table. */
  remaps: ActionRemap
}

/**
 * Build a {@link SemanticActionRemaps} bundle from `[semantic, handler]` pairs.
 * The {@link SemanticActionId} key type makes the table self-documenting and
 * keeps callers from accidentally remapping concrete handler ids.
 *
 * @example
 * ```ts
 * const remaps = defineSemanticActionRemaps([
 *   ["action.cancel", "modal.close"],
 *   ["action.submit", "form.submit"],
 * ]);
 * ```
 */
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
