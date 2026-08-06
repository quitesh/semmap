/**
 * The emacs **universal-argument** (`C-u`) paradigm, expressed as neutral
 * combinator productions over the `uarg` effect plus the generic greedy
 * {@link star} repeat.
 *
 * Grammar (greedy repeat — completion only on a non-prefix key, the same
 * discipline as `count`):
 *
 *   prefixArg → C-u[init] ( -[sign] )? ( C-u[times4] | <digit>[digit] )*
 *             | ε                                  (no `C-u` yet → no prefix)
 *
 * The whole matcher is nullable: with no `C-u` the command beneath resolves with
 * no count, identical to a bare action. All the value math (4 → ×4 → numeric
 * replace → sign flip) lives in the `uarg` effect (`step.ts#applyUarg`); the
 * grammar only sequences keys. The `-` is gated **structurally** by grammar
 * position: it is a one-shot optional reachable ONLY immediately after the first
 * `C-u`, before any `C-u`/digit — exactly the bare `C-u -4` state emacs accepts.
 * The recognizer is therefore purely structural; no effect reads builder state to
 * gate a match.
 *
 * Neutral: the uarg key and the sign key come from the keymap, not hardcoded.
 */

import { choice, key, type Matcher, seq, star } from '../matcher.js'

/** Digit keys a universal-argument accepts in either plain or numeric mode (0-9). */
const UARG_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * Build the universal-argument prefix matcher (nullable: the bare-action case is
 * the eps alternative).
 *
 * @param uargKey - Canonical key bound to the universal-argument action (e.g. `'C-u'`).
 * @param signKey - Canonical key that flips the sign (default `'-'`).
 */
export function prefixArg(uargKey: string, signKey = '-'): Matcher {
  // The loop offers `C-u`/digits every iteration; they always match (no gating).
  const loop = star(
    key(uargKey, { kind: 'uarg', op: 'times4' }),
    ...UARG_DIGITS.map((d) => key(d, { kind: 'uarg', op: 'digit' })),
  )
  // One-shot, nullable `-`: structurally reachable only right after `init`,
  // before any `C-u`/digit — the lone state emacs flips the sign in.
  const optSign = choice(key(signKey, { kind: 'uarg', op: 'sign' }), seq())
  // `choice(seq(C-u init, optSign, loop), seq())` — the empty seq is the nullable exit.
  return choice(seq(key(uargKey, { kind: 'uarg', op: 'init' }), optSign, loop), seq())
}
