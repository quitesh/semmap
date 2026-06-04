import { type BindingEntry, type KeyEvent, type ModeId, normalizeKeyEvent } from './modeRegistry.js'

export type { BindingEntry }

/**
 * Default action id strings emitted by the engine when its vim/emacs grammar
 * resolves. These ARE the literal action ids — consumers referencing
 * `Actions.OPERATOR_DELETE` get the exact value the default mapping emits.
 *
 * The `vim.` prefix on the operator defaults is a historical accident; non-vim
 * consumers (e.g. browser keymaps) override via the `operatorActions` /
 * `universalArgAction` constructor options and reference their own ids when
 * registering remaps.
 */
export const Actions = {
  OPERATOR_DELETE: 'vim.delete',
  OPERATOR_CHANGE: 'vim.change',
  OPERATOR_YANK: 'vim.yank',
  UNIVERSAL_ARG: 'action.universalArgument',
} as const

/** An ordered keymap iterable (top-of-stack first). The engine calls
 *  `iterateKeymaps()` on every key press and walks top-down, stopping
 *  at the first binding. */
export interface KeymapSource {
  iterateKeymaps(): Iterable<Map<string, BindingEntry>>
  /** True when the current context should accumulate leading digit counts
   *  (vim-normal, vim-visual, vim-visual-line). False for emacs and
   *  vim-insert — digits there type rather than count. Operator-pending
   *  overrides this and is handled separately by the engine. */
  acceptsLeadingCount(): boolean
}

// ── Types ────────────────────────────────────────────────────────────

export interface EngineResult {
  type:
    | 'action'
    | 'passthrough'
    | 'pending'
    | 'unmatched'
    | 'composing'
    /** A prefix-chord was active and the user pressed a key not in its
     *  continuation keymap (e.g. `C-x q`). The chord is cancelled and the
     *  key is *eaten* — callers must `preventDefault`/`stopPropagation` so
     *  the key does not fall through to the base keymap or type into a
     *  focused input. Distinct from `unmatched`, which has the opposite
     *  contract (let the native event reach the input). */
    | 'chordCancelled'
  action?: string
  motion?: string
  count?: number
  modeChanged?: ModeId
  pendingDisplay?: string
  /** For `chordCancelled`: space-joined keys the user actually pressed
   *  (prefix + unbound continuation, e.g. `"C-x q"`) so the caller can
   *  surface an emacs-style `"… is undefined"` modeline message. */
  cancelledDisplay?: string
}

export interface EngineState {
  currentMode: ModeId
  pendingDisplay: string
}

/**
 * Static keymap conflict reported by the synthesizer that builds engine modes
 * from default + plugin + user YAML bindings.
 *
 * - **chord-shadow** — same key bound to a flat action *and* a chord prefix in
 *   the same parent mode. The prefix wins, the flat action is unreachable.
 * - **fan-out** — same key in the same parent mode bound to more than one
 *   action. Always wrong; the engine keeps one binding arbitrarily and reports
 *   the rest.
 *
 * Both shapes set `flatActions` to the actions on the leaf and
 * `chordContinuations` to the keys that continue the prefix (empty `[]` for
 * pure fan-out).
 */
export interface KeymapConflict {
  /** Engine mode the conflict was found in (e.g. `emacs`, `insert`, `prefix:C-x@emacs`). */
  modeId: ModeId
  /** Path of normalised key strings from the parent persistent mode to the conflict node. */
  path: readonly string[]
  /** Actions bound to that path as a leaf binding. */
  flatActions: readonly string[]
  /** Continuation keys (chord prefixes that shadow the leaf). */
  chordContinuations: readonly string[]
}

function isDigit(keyStr: string): boolean {
  return keyStr.length === 1 && keyStr >= '0' && keyStr <= '9'
}

// ── Engine ───────────────────────────────────────────────────────────

// ── Overlay ──────────────────────────────────────────────────────────

type OverlayKind = 'operator-pending' | 'prefix-chord'

interface Overlay {
  kind: OverlayKind
  /** Captured continuation keymap (motion subkeymap for operator-pending;
   *  chord continuation map for prefix-chord). */
  keymap: Map<string, BindingEntry>
  /** For prefix-chord: display string for the modeline. */
  display?: string
  /** For prefix-chord: timer handle for the 1 s cancel. */
  timer?: ReturnType<typeof setTimeout>
}

interface EngineSnapshot {
  overlay: Overlay | null
  pendingKeys: string[]
  countAccum: number | null
  operatorPending: string | null
  operatorCount: number | null
  universalArg: number | null
  universalArgKind: 'plain' | 'numeric'
  universalArgSign: 1 | -1
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class KeyboardEngine {
  private source: KeymapSource
  private overlay: Overlay | null = null
  private pendingKeys: string[] = []
  private countAccum: number | null = null
  private operatorPending: string | null = null
  private operatorCount: number | null = null
  /**
   * Emacs-style **universal argument** (`C-u`): bind a key to
   * `action.universalArgument` and pressing it accumulates a numeric prefix
   * for the next command. Repeated `C-u` multiplies by 4 (`4 → 16 → 64 …`);
   * digits switch the prefix into numeric mode (`C-u 5 0 → 50`); `-` flips
   * sign while still in plain mode. The next non-prefix action consumes the
   * value as `EngineResult.count` and clears the prefix. `C-g` / `Escape`
   * also clears.
   */
  private universalArg: number | null = null
  private universalArgKind: 'plain' | 'numeric' = 'plain'
  private universalArgSign: 1 | -1 = 1
  private listeners: Set<() => void> = new Set()
  private cachedState: EngineState | null = null
  private suppressNotify = false
  private readonly conflicts: readonly KeymapConflict[]
  /**
   * `Esc` / `C-g` and unmatched continuations cancel a chord prefix; a 1 s
   * timeout is the third escape hatch (the user wandered off mid-chord).
   * Operator-pending and `C-u` deliberately don't time out.
   */
  private readonly prefixTimeoutMs: number
  private prefixTimer: ReturnType<typeof setTimeout> | null = null
  private readonly operatorActions: Record<string, string>
  private readonly universalArgAction: string

  constructor(
    source: KeymapSource,
    options: {
      conflicts?: readonly KeymapConflict[]
      prefixTimeoutMs?: number
      /** Override which action id each vim operator emits. Default:
       *  `{ d: Actions.OPERATOR_DELETE, c: Actions.OPERATOR_CHANGE,
       *     y: Actions.OPERATOR_YANK }`. */
      operatorActions?: Record<string, string>
      /** Override the action id that triggers universal-argument
       *  accumulation. Default: `Actions.UNIVERSAL_ARG`. */
      universalArgAction?: string
    } = {},
  ) {
    this.conflicts = options.conflicts ?? []
    this.prefixTimeoutMs = options.prefixTimeoutMs ?? 1000
    this.source = source
    this.operatorActions = options.operatorActions ?? {
      d: Actions.OPERATOR_DELETE,
      c: Actions.OPERATOR_CHANGE,
      y: Actions.OPERATOR_YANK,
    }
    this.universalArgAction = options.universalArgAction ?? Actions.UNIVERSAL_ARG
  }

  getConflicts(): readonly KeymapConflict[] {
    return this.conflicts
  }

  /** Clear any pending chord timer. */
  dispose(): void {
    this.clearPrefixTimeout()
  }

  /** Call when the external keymap source changes (e.g. scope stack swap).
   *  Clears any in-progress grammar overlay and pending state. */
  onKeymapSourceChanged(): void {
    this.clearOverlay()
    this.resetCountAndOperator()
    this.resetUniversalArg()
    this.cachedState = null
    this.notify()
  }

  private clearOverlay(): void {
    if (this.overlay?.timer) clearTimeout(this.overlay.timer)
    this.overlay = null
  }

  /** Count accumulation (e.g. "3dw" = delete 3 words) is only meaningful in vim
   *  normal/visual mode or while an operator is pending. Without this guard,
   *  digit keys in insert/emacs mode would be swallowed instead of typed. */
  private get countsEnabled(): boolean {
    return this.source.acceptsLeadingCount() || this.operatorPending !== null
  }

  /** Resolve {@link processKey} without mutating engine state (for previews / parity checks). */
  peekProcessKey(e: KeyEvent): EngineResult {
    const snap = this.takeSnapshot()
    const prevSuppress = this.suppressNotify
    this.suppressNotify = true
    try {
      return this.processKey(e)
    } finally {
      this.restoreSnapshot(snap)
      this.suppressNotify = prevSuppress
    }
  }

  processKey(e: KeyEvent): EngineResult {
    if ((e as { isComposing?: boolean }).isComposing) {
      return { type: 'composing' }
    }
    const keyStr = normalizeKeyEvent(e)
    if (!keyStr) return { type: 'unmatched' }

    // Clear any chord-prefix timer; a new key has arrived so the timeout's
    // job is done. Re-armed below if this key starts another prefix.
    this.clearPrefixTimeout()

    // Cancel keys: C-g or Escape
    if (keyStr === 'C-g' || keyStr === 'Escape') {
      if (this.operatorPending !== null || this.countAccum !== null || this.universalArg !== null) {
        this.resetPending()
        return { type: 'unmatched' }
      }
      // Otherwise fall through to normal key resolution
    }

    // Universal-argument accumulation
    if (this.universalArg !== null) {
      if (isDigit(keyStr)) {
        if (this.universalArgKind === 'plain') {
          this.universalArg = parseInt(keyStr, 10)
          this.universalArgKind = 'numeric'
        } else {
          this.universalArg = this.universalArg * 10 + parseInt(keyStr, 10)
        }
        this.pendingKeys.push(keyStr)
        this.notify()
        return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
      }
      if (
        keyStr === '-' &&
        this.universalArgKind === 'plain' &&
        this.universalArgSign === 1 &&
        this.universalArg === 4
      ) {
        this.universalArgSign = -1
        this.pendingKeys.push(keyStr)
        this.notify()
        return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
      }
    }

    // Count accumulation
    if (this.universalArg === null && this.countsEnabled && isDigit(keyStr)) {
      if (keyStr === '0' && this.countAccum === null) {
        // Fall through to normal resolution
      } else {
        this.countAccum = (this.countAccum ?? 0) * 10 + parseInt(keyStr, 10)
        this.pendingKeys.push(keyStr)
        this.notify()
        return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
      }
    }

    return this.resolveKey(keyStr)
  }

  private resolveKey(keyStr: string): EngineResult {
    // Named overlay takes precedence on both paths.
    if (this.overlay) {
      const entry = this.overlay.keymap.get(keyStr)
      if (entry) return this.handleEntry(entry, keyStr, this.overlay.keymap)
      // Miss in overlay. Prefix-chord: cancel the chord AND swallow the key
      // (emacs/vim semantics — an unbound continuation eats itself; otherwise
      // `C-x q` would either trigger the standalone `q` binding or leak `q`
      // into a focused input). Operator-pending: clear and re-resolve against
      // the base — that overlay kind has its own semantics, keep it as-is.
      if (this.overlay.kind === 'prefix-chord') {
        // pendingKeys already includes any leading C-u / count digits, so the
        // display matches emacs (`C-u 4 C-x q is undefined`). resetPending
        // clears overlay + pendingKeys + countAccum + operatorPending +
        // universalArg in one shot — without it, a pre-chord `C-u` would
        // leak its prefix count into the next command.
        const cancelledDisplay = [...this.pendingKeys, keyStr].join(' ')
        this.resetPending()
        return { type: 'chordCancelled', cancelledDisplay }
      }
      this.clearOverlay()
      this.pendingKeys = []
    }

    // Walk keymaps top-down.
    for (const km of this.source.iterateKeymaps()) {
      const entry = km.get(keyStr)
      if (entry) return this.handleEntry(entry, keyStr, km)
    }
    return { type: 'unmatched' }
  }

  private handleEntry(
    entry: BindingEntry,
    keyStr: string,
    sourceKeymap: Map<string, BindingEntry>,
  ): EngineResult {
    switch (entry.type) {
      case 'action': {
        if (entry.action === this.universalArgAction) {
          if (this.universalArg === null) {
            this.universalArg = 4
            this.universalArgKind = 'plain'
            this.universalArgSign = 1
          } else if (this.universalArgKind === 'plain') {
            this.universalArg *= 4
          } else {
            this.universalArg = 4
            this.universalArgKind = 'plain'
            this.universalArgSign = 1
          }
          this.pendingKeys.push(keyStr)
          this.notify()
          return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
        }
        const count = this.resolveCount()
        this.clearOverlay()
        this.resetCountAndOperator()
        this.resetUniversalArg()
        this.notify()
        return { type: 'action', action: entry.action, count }
      }

      case 'operator': {
        this.operatorCount = this.countAccum
        this.countAccum = null
        this.operatorPending = entry.operator
        this.pendingKeys.push(keyStr)

        // Capture the source keymap (the one the operator binding came from)
        // as the motion overlay, not just the top-of-stack keymap.
        this.overlay = { kind: 'operator-pending', keymap: sourceKeymap }
        this.notify()
        return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
      }

      case 'motion': {
        const motionCount = this.countAccum ?? 1
        if (this.operatorPending) {
          const opCount = this.operatorCount ?? 1
          const totalCount = opCount * motionCount
          const operator = this.operatorPending
          const motion = entry.motion
          this.clearOverlay()
          this.resetCountAndOperator()
          this.notify()
          const action = this.operatorActions[operator]
          if (!action) {
            return { type: 'unmatched' }
          }
          return { type: 'action', action, motion, count: totalCount }
        } else {
          const count = motionCount
          this.resetCountAndOperator()
          this.notify()
          return { type: 'action', action: `motion:${entry.motion}`, count }
        }
      }

      case 'prefix': {
        const keymap = entry.keymap
        this.overlay = { kind: 'prefix-chord', keymap, display: keyStr }
        this.pendingKeys.push(keyStr)
        this.armPrefixTimeout()
        this.notify()
        return { type: 'pending', pendingDisplay: this.buildPendingDisplay() }
      }

      case 'passthrough': {
        this.resetCountAndOperator()
        this.resetUniversalArg()
        this.notify()
        return { type: 'passthrough' }
      }
    }
  }

  private armPrefixTimeout(): void {
    // peek path: snapshot/restore can't unwind a real timer, so don't fire one.
    if (this.suppressNotify) return
    this.clearPrefixTimeout()
    this.prefixTimer = setTimeout(() => {
      this.prefixTimer = null
      // Timer can race with a key arriving and clearing the timeout — guard
      // against firing after the prefix was already resolved or canceled.
      const hasOverlay = this.overlay?.kind === 'prefix-chord'
      if (hasOverlay) {
        this.clearOverlay()
        this.pendingKeys = []
        this.notify()
      }
    }, this.prefixTimeoutMs)
  }

  private clearPrefixTimeout(): void {
    if (this.prefixTimer) {
      clearTimeout(this.prefixTimer)
      this.prefixTimer = null
    }
  }

  private resolveCount(): number {
    if (this.universalArg !== null) {
      return this.universalArg * this.universalArgSign
    }
    if (this.operatorPending) {
      return (this.operatorCount ?? 1) * (this.countAccum ?? 1)
    }
    return this.countAccum ?? 1
  }

  private resetCountAndOperator(): void {
    this.countAccum = null
    this.operatorCount = null
    this.operatorPending = null
    this.pendingKeys = []
  }

  private resetUniversalArg(): void {
    this.universalArg = null
    this.universalArgKind = 'plain'
    this.universalArgSign = 1
  }

  private resetPending(): void {
    this.clearPrefixTimeout()
    this.clearOverlay()
    this.resetCountAndOperator()
    this.resetUniversalArg()
    this.notify()
  }

  private buildPendingDisplay(): string {
    if (this.universalArg !== null) {
      const sign = this.universalArgSign === -1 ? '-' : ''
      return `C-u ${sign}${this.universalArg}`
    }
    const parts: string[] = []
    if (this.operatorCount !== null) parts.push(String(this.operatorCount))
    if (this.operatorPending) parts.push(this.operatorPending)
    if (this.countAccum !== null && this.operatorPending) parts.push(String(this.countAccum))
    if (!this.operatorPending && this.pendingKeys.length > 0) {
      return this.pendingKeys.join(' ')
    }
    return parts.join('')
  }

  peekState(): EngineState {
    return {
      currentMode: '',
      pendingDisplay: this.buildPendingDisplay(),
    }
  }

  getState(): EngineState {
    if (this.cachedState) return this.cachedState
    this.cachedState = {
      currentMode: '',
      pendingDisplay: this.buildPendingDisplay(),
    }
    return this.cachedState
  }

  reset(): void {
    this.resetPending()
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private takeSnapshot(): EngineSnapshot {
    // Snapshot the overlay reference (no deep clone of keymap — identity is enough
    // for restore; the keymap itself is immutable during a peek).
    // Note: the timer is NOT snapshotted — peek suppresses notifications so
    // armPrefixTimeout never fires a real timer during peek anyway.
    const overlay = this.overlay ? { ...this.overlay, timer: undefined } : null
    return {
      overlay,
      pendingKeys: [...this.pendingKeys],
      countAccum: this.countAccum,
      operatorPending: this.operatorPending,
      operatorCount: this.operatorCount,
      universalArg: this.universalArg,
      universalArgKind: this.universalArgKind,
      universalArgSign: this.universalArgSign,
    }
  }

  private snapshotMatches(s: EngineSnapshot): boolean {
    return (
      this.overlay === s.overlay &&
      arraysEqual(this.pendingKeys, s.pendingKeys) &&
      this.countAccum === s.countAccum &&
      this.operatorPending === s.operatorPending &&
      this.operatorCount === s.operatorCount &&
      this.universalArg === s.universalArg &&
      this.universalArgKind === s.universalArgKind &&
      this.universalArgSign === s.universalArgSign
    )
  }

  private restoreSnapshot(s: EngineSnapshot): void {
    if (this.snapshotMatches(s)) return
    // Clear any timer that may have been armed during the peek (suppressed, so no
    // real timer fires, but clearOverlay is safe to call on null).
    this.clearOverlay()
    this.overlay = s.overlay
    this.pendingKeys = s.pendingKeys
    this.countAccum = s.countAccum
    this.operatorPending = s.operatorPending
    this.operatorCount = s.operatorCount
    this.universalArg = s.universalArg
    this.universalArgKind = s.universalArgKind
    this.universalArgSign = s.universalArgSign
    this.cachedState = null
  }

  private notify(): void {
    if (this.suppressNotify) return

    const newState = {
      currentMode: '',
      pendingDisplay: this.buildPendingDisplay(),
    }

    if (this.cachedState && this.cachedState.pendingDisplay === newState.pendingDisplay) {
      return
    }

    this.cachedState = newState
    for (const cb of this.listeners) cb()
  }
}
