/**
 * The neutral command-grammar AST: matchers (the grammar combinators), effects
 * (syntax-directed output-register writes), and the registry (semantic
 * namespace → key → effect).
 *
 * This module is grammar-agnostic — it knows nothing about vim, emacs, operators,
 * or doubling. Editor semantics live in presets built from these combinators.
 */

/**
 * The syntax-directed output a matcher emits when it matches a key. Effects write
 * to **output-only** builder registers; they are never read back to gate a later
 * match (the recognizer is purely structural). `find-arg` captures the consumed
 * key (from a wildcard {@link literal}) into the motion arg.
 */
export type Eff =
  | { kind: 'operator'; id: string }
  | { kind: 'motion'; id: string }
  | { kind: 'action'; id: string }
  | { kind: 'linewise' }
  | { kind: 'to-scope'; scope: 'i' | 'a' }
  | { kind: 'to-object'; id: string }
  | { kind: 'find-arg' } // captures the consumed key into motion.arg
  | { kind: 'find-marker'; id: string } // marks an in-progress find motion
  /**
   * Universal-argument (`C-u`) accumulation step (the emacs prefix paradigm; see
   * `presets/prefixArg.ts`). Like every other effect, these ops only WRITE
   * registers; none gates a match. The `-` (`sign`) is restricted to the bare
   * `C-u -4` state **structurally** — the grammar offers it only there — so `sign`
   * just flips unconditionally. The `times4`/`digit` ops read `uargKind` to COMPUTE
   * the value (×4 vs reset, replace vs append), which is value math, not gating.
   * The `uargValue`/`uargKind`/`uargSign` builder registers carry the running prefix.
   *   - `init`    first `C-u`  → value 4, kind plain, sign +1
   *   - `times4`  repeated `C-u` while plain → ×4; while numeric → reset to 4/plain
   *   - `digit`   digit while plain → value = digit, kind numeric; while numeric → ×10 + digit
   *   - `sign`    `-` → flip sign (reachable only at the bare state by grammar position)
   */
  | { kind: 'uarg'; op: 'init' | 'times4' | 'digit' | 'sign' }
  /** A bound key that intentionally yields to the host (emacs `passthrough`). */
  | { kind: 'passthrough' }

/**
 * The grammar AST. A {@link Matcher} tree is compiled (see `compile.ts`) into an
 * LL(1) table; it is never tree-interpreted in production.
 *
 * - `key` — match a specific key; emit its (optional) effect.
 * - `group` — match any key registered in semantic namespace `name`; emit that
 *   key's effect from the registry.
 * - `literal` — a wildcard terminal: consume ANY next key, capturing it (used by
 *   `f`/`t`/`r`/registers). Compiles to the "any" column.
 * - `count` — a greedy `[0-9]*` accumulator, nullable. The `0`-rule (0 is a
 *   count-digit only mid-count) is encoded structurally at compile time.
 * - `seq` / `choice` — ordered composition / alternation.
 */
export type Matcher =
  | { t: 'key'; key: string; eff?: Eff }
  | { t: 'group'; name: string }
  | { t: 'literal'; eff: Eff }
  | { t: 'count' }
  | { t: 'star'; xs: Matcher[] }
  | { t: 'seq'; xs: Matcher[] }
  | { t: 'choice'; xs: Matcher[] }

/** Semantic namespace → (canonical key → effect). */
export type Registry = Record<string, Map<string, Eff>>

// ── Combinator constructors ──────────────────────────────────────────

/** Match a specific key, optionally emitting `eff` when it matches. */
export const key = (k: string, eff?: Eff): Matcher => ({ t: 'key', key: k, eff })

/** Match any key registered in semantic namespace `name`; emit that key's effect. */
export const group = (name: string): Matcher => ({ t: 'group', name })

/** A wildcard terminal: consume any next key, applying `eff` (which may capture it). */
export const literal = (eff: Eff): Matcher => ({ t: 'literal', eff })

/** A greedy leading-count accumulator (`[0-9]*`, nullable, 0-rule structural). */
export const count = (): Matcher => ({ t: 'count' })

/**
 * A greedy `(x1 | x2 | …)*` repeat (nullable; completion only on a non-matching
 * key — the same discipline as {@link count}). The alternatives' FIRST sets must
 * be disjoint from each other and from the repeat's FOLLOW (the key that ends it),
 * exactly like any LL(1) `choice`. This is the generic greedy repeat the emacs
 * universal-argument tail is built from.
 */
export const star = (...xs: Matcher[]): Matcher => ({ t: 'star', xs })

/** Ordered sequence. */
export const seq = (...xs: Matcher[]): Matcher => ({ t: 'seq', xs })

/** Ordered alternation (FIRST/FIRST-disjoint at compile time). */
export const choice = (...xs: Matcher[]): Matcher => ({ t: 'choice', xs })
