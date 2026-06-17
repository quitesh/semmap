/**
 * The resolved {@link Command} (the recognizer's output) plus the output-only
 * {@link Builder} accumulator and {@link finalize}, which synthesizes a Command
 * from a builder.
 *
 * Builder registers are **forward, output-only**: effects write them and
 * `finalize` reads them; nothing reads them to gate a match. There is no
 * `sawOperator` flag — which count slot a digit feeds is derived from the count
 * nonterminal on the parse stack (its grammar position), never from builder state.
 */

/**
 * A resolved command. Captures **semantic ids and resolved values**, never
 * keystrokes — so dot-repeat re-runs the resolved pattern non-interactively.
 */
export interface Command {
  count?: number // effective (count1 * count2)
  operator?: string
  motion?: { id: string; arg?: string; count?: number }
  textObject?: { scope: 'i' | 'a'; id: string }
  linewise?: boolean
  action?: string
  /** A bound key that yields to the host (emacs `passthrough`). */
  passthrough?: boolean
}

/**
 * Output-only accumulator. Effects write these registers during a parse;
 * `finalize` reads them once the command resolves. `count1` (pre-operator) and
 * `count2` (operand) are distinct slots, fed by position (the owning count
 * nonterminal), not by any flag.
 */
export interface Builder {
  count1?: number
  count2?: number
  operator?: string
  motionId?: string
  motionArg?: string
  action?: string
  linewise?: boolean
  toScope?: 'i' | 'a'
  toObject?: string
  passthrough?: boolean
  /**
   * Universal-argument (`C-u`) running prefix. Written by the `uarg` effect
   * (see `presets/prefixArg.ts`); `finalize` folds it into `count = value * sign`.
   * `uargKind` distinguishes the plain `C-u`-multiplier state (`4 → 16 → …`) from
   * the digit-entry state (`C-u 5 0 → 50`); `uargSign` carries the `-` flip.
   */
  uargValue?: number
  uargKind?: 'plain' | 'numeric'
  uargSign?: 1 | -1
}

/** A fresh, empty builder. */
export function freshBuilder(): Builder {
  return {}
}

/** Synthesize a {@link Command} from the accumulated builder registers. */
export function finalize(b: Builder): Command {
  const cmd: Command = {}
  // Universal-argument prefix wins as the effective count when present: the emacs
  // `C-u` value carries its own sign and overrides any leading count slots.
  if (b.uargValue !== undefined) {
    cmd.count = b.uargValue * (b.uargSign ?? 1)
  } else if (b.count1 !== undefined || b.count2 !== undefined) {
    // Effective count: (count1 ?? 1) * (count2 ?? 1), set only if either present.
    cmd.count = (b.count1 ?? 1) * (b.count2 ?? 1)
  }
  if (b.operator !== undefined) cmd.operator = b.operator
  if (b.linewise) cmd.linewise = true
  if (b.action !== undefined) cmd.action = b.action
  if (b.passthrough) cmd.passthrough = true
  if (b.toObject !== undefined) cmd.textObject = { scope: b.toScope ?? 'i', id: b.toObject }
  if (b.motionId !== undefined) {
    cmd.motion = { id: b.motionId }
    if (b.motionArg !== undefined) cmd.motion.arg = b.motionArg
  }
  return cmd
}
