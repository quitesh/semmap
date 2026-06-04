import type { ActionId, ActionRemap, HandlerActionId, Keymap, KeymapActionId } from './keymap.js'

export interface ActionArgs {
  /** Numeric prefix (emacs C-u, vim leading count). */
  count?: number
  /** Motion identifier for vim operator handlers. */
  motion?: string
}

export type HandlerFn = (action: HandlerActionId, args: ActionArgs) => boolean

export interface Scope {
  /**
   * Identity for pushOrUpdate. Pushes with an id already on the stack
   * update in place rather than restructuring.
   */
  id: string
  /**
   * Optional keymap (key → BindingEntry). Discouraged outside passthrough
   * scopes — see spec § "Why per-scope keymaps are discouraged outside
   * passthrough."
   */
  keymap?: Keymap
  /**
   * Optional semantic/keymap action bindings that remain visible through a
   * `claimsInput` surface. Use this for global semantic meanings
   * (`action.cancel`, `action.submit`, …), not concrete handler actions.
   */
  semanticKeymap?: Keymap
  /**
   * Optional semantic/keymap action → concrete handler action routing applied
   * by the dispatcher before handler lookup. Walked top-down; first match wins.
   */
  remaps?: ActionRemap
  /**
   * Optional concrete handler action → handler map. Handler returns `true`
   * to claim the action; `false` to let the dispatcher continue walking.
   */
  handlers?: ReadonlyMap<HandlerActionId, HandlerFn>
  /**
   * When set, the scope stack's normal keymap, remap, and handler walks stop
   * at (and include) this scope — scopes below it are skipped. Semantic
   * keymaps below the floor still participate so semantic actions like
   * `action.cancel` can be produced and then remapped by the claiming surface.
   */
  claimsInput?: boolean
  /**
   * When true, this scope signals that leading digit key presses should
   * accumulate as a count prefix (vim-normal, vim-visual, vim-visual-line).
   * Emacs and vim-insert scopes leave this unset/false.
   */
  acceptsLeadingCount?: boolean
}

/**
 * Ordered stack of scope records. Bottom = lowest priority (`app`);
 * top = highest priority. Mutations notify subscribers when anything
 * resolution-affecting changes.
 */
export class ScopeStack {
  private scopes: Scope[] = []
  private subscribers = new Set<() => void>()

  /**
   * Insert or update a scope. Identity is by `id`: if a scope with the
   * same id already exists, its fields are replaced in place. Otherwise
   * the scope is pushed onto the top.
   *
   * Notifies subscribers only when something that affects resolution
   * changes — keymap / semanticKeymap / remaps / handlers /
   * claimsInput identity, or stack shape (push / pop / reorder).
   */
  pushOrUpdate(scope: Scope): void {
    const existing = this.scopes.findIndex((s) => s.id === scope.id)
    if (existing >= 0) {
      const old = this.scopes[existing]!
      if (
        old.keymap === scope.keymap &&
        old.semanticKeymap === scope.semanticKeymap &&
        old.remaps === scope.remaps &&
        old.handlers === scope.handlers &&
        old.claimsInput === scope.claimsInput &&
        old.acceptsLeadingCount === scope.acceptsLeadingCount
      ) {
        // Field identities all equal → nothing to do.
        return
      }
      this.scopes[existing] = scope
    } else {
      this.scopes.push(scope)
    }
    this.notify()
  }

  pop(id: string): void {
    const idx = this.scopes.findIndex((s) => s.id === id)
    if (idx < 0) return
    this.scopes.splice(idx, 1)
    this.notify()
  }

  /**
   * Snapshot of scope ids, bottom→top. Test/diagnostics helper.
   */
  snapshotIds(): string[] {
    return this.scopes.map((s) => s.id)
  }

  /**
   * Index of the topmost scope with `claimsInput`, or null when no scope
   * claims.
   */
  private claimsInputFloor(): number | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i]!.claimsInput) return i
    }
    return null
  }

  /**
   * Returns true if any scope at or above the `claimsInput` floor has
   * `acceptsLeadingCount` set, indicating that leading digit presses
   * should accumulate as a count prefix (vim-normal/visual modes).
   */
  acceptsLeadingCount(): boolean {
    const floor = this.claimsInputFloor() ?? 0
    for (let i = this.scopes.length - 1; i >= floor; i--) {
      if (this.scopes[i]!.acceptsLeadingCount) return true
    }
    return false
  }

  /**
   * Yield keymaps top-down. When no scope claims input, this is the normal
   * keymap stack. When a scope claims input, normal keymaps below the floor
   * are hidden, but semantic keymaps below the floor still pass through.
   */
  *iterateKeymaps(): IterableIterator<Keymap> {
    const floor = this.claimsInputFloor()
    if (floor === null) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const km = this.scopes[i]!.keymap
        if (km !== undefined) yield km
      }
      return
    }
    for (let i = this.scopes.length - 1; i >= floor; i--) {
      const km = this.scopes[i]!.keymap
      if (km !== undefined) yield km
    }
    for (let i = floor - 1; i >= 0; i--) {
      const km = this.scopes[i]!.semanticKeymap
      if (km !== undefined) yield km
    }
  }

  /**
   * Recursively follows remap chains top-down until no scope maps the current
   * target. Cycle detection prevents infinite loops. Skips scopes below the
   * `claimsInput` floor. The return value is the concrete handler action when
   * a remap exists, or the original action for direct concrete bindings.
   */
  walkRemap(action: KeymapActionId): HandlerActionId {
    const floor = this.claimsInputFloor() ?? 0
    const seen = new Set<ActionId>()
    let current = action
    while (true) {
      if (seen.has(current)) return current
      seen.add(current)
      let next: HandlerActionId | undefined
      for (let i = this.scopes.length - 1; i >= floor; i--) {
        const target = this.scopes[i]!.remaps?.get(current)
        if (target !== undefined) {
          next = target
          break
        }
      }
      if (next === undefined) return current
      current = next
    }
  }

  /**
   * Walks scopes top-down, invoking the first handler the action
   * matches. If a handler returns `true` the walk stops and the
   * function returns `true`. Otherwise (no eligible handler, or every
   * eligible handler returned `false`) returns `false`.
   *
   * Skips scopes below the `claimsInput` floor.
   */
  walkHandler(action: HandlerActionId, args: ActionArgs = {}): boolean {
    const floor = this.claimsInputFloor() ?? 0
    for (let i = this.scopes.length - 1; i >= floor; i--) {
      const fn = this.scopes[i]!.handlers?.get(action)
      if (fn?.(action, args)) return true
    }
    return false
  }

  /**
   * Remap then dispatch `action` through all scopes, ignoring any
   * `claimsInput` floor. Use when an action is triggered by a UI
   * gesture (e.g. command-palette item click) while a claiming scope
   * is still mounted — the caller has already committed to closing the
   * claiming surface, so the floor should not cap the dispatch.
   */
  dispatchAction(action: HandlerActionId, args: ActionArgs = {}): boolean {
    // Walk remaps recursively across all scopes (top-down), with cycle detection.
    const seen = new Set<ActionId>()
    let current = action
    while (true) {
      if (seen.has(current)) break
      seen.add(current)
      let next: HandlerActionId | undefined
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const target = this.scopes[i]!.remaps?.get(current)
        if (target !== undefined) {
          next = target
          break
        }
      }
      if (next === undefined) break
      current = next
    }
    // Walk handlers across all scopes (top-down).
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const fn = this.scopes[i]!.handlers?.get(current)
      if (fn?.(current, args)) return true
    }
    return false
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb)
    return () => {
      this.subscribers.delete(cb)
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) cb()
  }
}
