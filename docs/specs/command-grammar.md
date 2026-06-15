# Spec: Command grammar (keymap = positional classifier, grammar = recognizer)

Status: proposed — HP1/HP2/HP4/HP5/HP6 resolved; HP7 direction set; HP3 (`d/foo`
composition) parked as a deferrable feature-slice. Ready for a consolidation pass.
Owner: —
Supersedes: the "grammar reducers" sketch (reducers are the small-grammar
special case; a declarative grammar is the general form).
Related: `KeyboardEngine`, `EngineResult`, `EngineState`, `BindingEntry`,
presets/vim, `KeymapSource.acceptsLeadingCount`.

## Summary

Introduce a general **command grammar** in the core engine, between the keymap
and the resolved result. Each editor mode has one keymap that classifies keys;
a per-mode **grammar** is an incremental recognizer that sequences keys into a
**structured command**. Vim and the emacs universal-argument become grammar
*presets* rather than hardcoded engine state. This is what makes "real" vim
grammar (text objects, `f<char>`, registers, multiplied counts, operator
doubling, `g`/`z` namespaces, search, visual) expressible at all.

## Goal (the thing to judge every decision against)

**Make building an evil-mode-class modal input scheme easy for a consumer** — a
declarative grammar *definition* over a shared in-core recognizer, not a
hand-rolled parser. evil-mode is thousands of lines of bespoke recognizer in
Lisp *precisely because* emacs's core offers no grammar; that effort is the pain
this work eliminates, not a success to emulate. Success = a consumer expresses
vim-class grammar (and emacs-class, and its own) as a grammar definition, and
gets static analysis (conflicts, which-key, dot-repeat) for free.

"Keep the core minimal / paradigm-neutral" is a real value, but a **secondary**
one. Where it conflicts with making rich grammars easy to define, *easy wins* —
that is the point of this work. Control over opinionated semantics (evil's
reason for existing) is served by making the **grammar definition** swappable,
*not* by keeping the recognizer out of the core. Never hardcode a specific
editor's semantics into the engine; do put the recognizer there.

## Decision status

Worked through in the brainstorm; the red-team then reopened HP1–HP3 (holes noted
inline). Current state:

- **Two-layer separation (load-bearing).** Grammar owns modal state and
  composition and *publishes selectors*; the keymap/binding layer is a dumb,
  declarative, scope-gated dispatch table the grammar drives. (§Two layers)
- **Recognizer architecture (settled).** Explicit `step` over a **serializable
  parse stack**, not generators — validated by the field survey (IdeaVim
  `CommandBuilder`, vim-mode-plus `operationStack`). (§Recognizer architecture)
- **HP1 — keymap/lexer.** *Resolved:* registry = flat key→class(es) map;
  multi-key things are grammar productions (no trie). Class-set positions resolved
  by the grammar's `choice` + selector-gating + the `0`-in-count-helper rule; the
  **grammar** owns operator-pending/position state. (§Keymap)
- **HP2 — incremental outputs.** *Resolved:* dead-end policy = per-mode default +
  innermost-frame (operatorPending→eat, insert→yield, count→resolve-and-refeed);
  `'resolve'` forbidden for destructive incomplete commands; `acceptableNext`
  class-level pure / key-level live; modeline = in-order positional traversal.
  (§Incremental recognizer)
- **HP3 — literal capture & sub-sessions.** Literal capture stays in-grammar.
  *Parked:* operator + interactive sub-operand (`d/foo`) — the semmap-specific
  "session-mount-is-the-cancel" contradiction; a deferrable feature-slice (every
  surveyed engine just keeps the parse stack alive across the sub-session). The
  §Sub-sessions section is an earlier engine-owned-buffer sketch, now superseded.
- **HP4 — visual & multi-grammar modes.** *Resolved:* visual = `selectionFirst`
  grammar over the shared normal keymap (vim is multi-paradigm); mode =
  `{keymap-ref, grammar}`, keymap shareable; recognizer-driven transitions publish
  `mode=visual` + selection-kind; selection consumer-owned; geometry-based repeat.
  (§Modes)
- **HP5 — output & dot-repeat.** *Resolved:* `Command` = structured output + the
  dot-repeat unit (resolved values, never keystrokes); **wrap** `EngineResult`
  (additive `command?`), don't replace; engine tracks last *recordable* command +
  replay primitive (consumer supplies insert-text payload); visual ops record
  geometry. (§Resolved command)
- **HP6 — author surface.** *Resolved:* registry (terminals) + general
  declarative composition substrate + paradigm helpers (`operatorPending`/…) +
  external escape hatch; recognizer stays declarative-only. (§Grammar)
- **HP7 — scope/binding resolution.** Direction set. (§Scope/binding resolution)

## Motivation

### Vim grammar has no keymap representation

The current model resolves keys through a keymap tree plus two ad-hoc overlays
(operator-pending, prefix-chord) and three accumulator fields (`countAccum`,
`operatorPending`/`operatorCount`, `universalArg`/kind/sign). Real vim normal
mode needs constructs none of those can express:

- **Literal-capturing terminals.** `f<char>`, `t<char>`, `F`/`T`, `r<char>`,
  `m<char>`, `` `<char> ``/`'<char>`, and register `"<reg>` consume the *next
  raw key* as an argument. `BindingEntry` has no "capture the next literal key."
- **Multiplied counts.** `2d3w` deletes 6 words — a count before the operator
  *and* before the motion, multiplied.
- **Operator doubling → linewise.** `dd`, `yy`, `cc`, `gugu`.
- **Text objects.** `i`/`a` + object char, valid only operator-pending/visual:
  `diw`, `ca(`, `yi"`.
- **Search motions.** `/pat<CR>` / `?pat<CR>` open an interactive sub-input that
  resumes as a motion operand.
- **`g` / `z` namespaces.** `gg`, `gu`, `gU`, `zz`, `zt` — grammar prefixes.
- **Visual mode** is a different grammar over the same tokens (operators apply
  to the selection; motions extend it).
- **`.` repeat and macros** must replay a *parsed command*, so the engine must
  emit a structured command, not just an action id.

### It also un-hardcodes the core

The engine today bakes vim/emacs grammar into the routing core
(`operatorActions`, `universalArgAction`, `acceptsLeadingCount`, the count and
operator-pending fields). A general grammar mechanism lets vim and
emacs-universal-arg move *out* of the core into presets, leaving the engine
grammar-agnostic.

**The grammar engine belongs in the core.** Resolving stateful multi-key input
into commands *is* the engine's job and its main value; the core owns a
first-class incremental recognizer. vim and emacs are both **grammars defined
with it** — emacs's is small (numeric-arg + prefix-keys), vim's is the
compositional one. They are *not* userland functions reassembling primitives.

emacs is the cautionary case, not the model. emacs has no grammar in its core —
`universal-argument`, `quoted-insert`, isearch, hydra are userland commands that
read input and install transient maps — so every rich input scheme (evil-mode,
hydra, god-mode) rebuilds the machinery in Lisp. Putting the recognizer in the
core is what (a) makes "define a grammar easily" a real library capability, and
(b) keeps input statically analyzable (conflicts, which-key, dot-repeat).

The recognizer is built from **primitives** — count/prefix-arg accumulation,
sub-mode push, literal capture, external suspend/resume. These are exposed as a
**secondary, opt-in escape hatch** for genuinely dynamic cases, analogous to
emacs's `set-transient-map`. They are building blocks you can drop to, not the
primary API — the grammar is primary.

The `count` primitive is shared in-core: vim's leading count and emacs's
universal-argument (`C-u`, `C-u C-u` = 16, `M-5`, `C-u -`) are one primitive
with different notation, used by a vim grammar production or an emacs
numeric-arg grammar alike.

## Model

```
key event → normalizeKeyEvent → KeyStr
  ▼
recognizer (active mode's grammar) asks: "classify this key for my position"
  ▼  → keymap lookup in the mode's keymap → symbol {class,id} | literal
  ▼
step the parse stack
  ▼  → Resolved | Pending | Cancelled(eat) | Unmatched(yield) | Suspended
  ▼
Resolved → structured Command → remap / handler (existing scope walk)
```

### Two layers: grammar publishes, keymap dispatches

The engine is two layers with a **one-way interface** (validated against Zed's
keymap engine):

1. **Grammar layer** — the incremental recognizer. The *authority* on modal
   state: counts, pending operator, register, composition, dot-repeat. It knows
   "we are operator-pending on `d`, awaiting a target," and it *publishes a small
   set of selectors* (`mode=operator`, `operator=d`, a pending count).
2. **Binding/keymap layer** — a dumb, declarative, scope-gated dispatch table. It
   resolves a key to an action/class **by selector**, and knows nothing about
   operators, counts, or composition.

The interface is one-directional: **grammar → publishes selectors → keymap reads
them.** This is exactly how Zed handles operator-pending — one keymap, no swap;
the vim state machine sets `vim_mode`/`vim_operator` context flags and bindings
predicate on them. It is the most important structural rule here, because it keeps
modal state *out* of the binding layer — where it would otherwise re-create
evil-mode's keymap-swapping and Zed's stringly-typed `vim_mode==waiting` hacks.

Where semmap should be **better than Zed**: Zed pays for cramming everything into
a flag-gated keymap — it flattens count to a boolean `VimCount` (the number is
invisible to bindings) and uses ad-hoc `waiting`/`literal` string overrides.
semmap's typed grammar keeps the count numeric and the class structured, so it
needs none of that: the grammar half is genuinely richer; the keymap half stays
dumb.

### Keymap and lexing (HP1)

The keymap is a **flat `key → class(es)` registry** — `w → motion:w`,
`d → operator:delete`, `i → {action:insert, textobject-scope}` — and one keymap is
**shared across modes that classify keys the same way** (normal/visual; insert
differs — see §Modes). The grammar owns **all** parse-position logic; operator-
pending, counts, doubling, and prefixes are *positions within a mode's grammar*,
**not** separate keymaps.

The **grammar owns operator-pending and all position state** (per §Two layers);
the keymap is the dumb dispatch table. At each position the grammar consults the
keymap for the next key's class(es) and composes the result. `i` is
`action:insert` at the normal "action" position and `textobject-scope` at an
operator's operand position — resolved by *which selector the grammar published*,
not by swapping keymaps.

> **RESOLVED (red-team holes closed via the HP6 grammar — no trie, no
> within-keymap precedence).** Positions *do* accept class sets, but the grammar
> resolves them: `target := choice(motion, textobject, literalMotion)`, and
> "longest-match" is just the grammar consuming more keys (`i` enters the
> `textobject` production; bare `w` is a motion). `textobject` only appears at the
> *operand* position in the grammar and is selector-gated, so `i` at normal-start
> isn't in its first-set — no pollution. `0` count-vs-`col-0`-motion is an explicit
> rule in the `count` helper (digit while a count is in progress, else the
> registered `0`→motion).

Consequences:

- **No per-parse-state keymaps.** Operator-pending reuses the *same* normal-mode
  keymap, so motions are shared automatically (`dw` and a bare `w` are the same
  `w`); we never duplicate or derive a separate op-pending map.
- **One keymap per *classification*, not per mode** (HP4): `normal` and `visual`
  share a keymap (`w` is a motion in both); `insert` is a different keymap (`w`
  types "w"). Motions aren't duplicated between normal and visual.
- **Doubling (`dd`/`cc`/`yy`) is a grammar rule** — "the operand may be the
  *pending operator's own key* → linewise" — not a keymap entry (it is
  per-operator, so it cannot be).
- **which-key = the grammar's next-set**, projected to keys (the predictive
  closure at the current position — §Incremental recognizer), not a
  hand-maintained per-state map.
- **Dynamic terminals just work**: lookups hit the live, per-scope-remapped
  keymap at parse time; rebinding a key updates one place.

### Tokens

When the grammar consults the keymap at a position, it gets either:

- a **keymap-resolved symbol** — `{ class, id }` (e.g. `{operator, delete}`,
  `{motion, w}`, `{textobject-scope, i}`); polysemous keys carry more than one
  class and the position picks; or
- a **literal** — the raw `KeyStr`, in a position that captures a literal
  argument (after `f`/`t`/`r`/`m`/`"`); the keymap is *not* consulted there.

Token classes are open-ended; the grammar declares which classes its positions
accept, and the keymap/preset assigns classes to keys.

### Grammar (author surface — HP6)

Three tiers, so the easy cases are easy and the hard cases stay possible:

1. **Terminals = a registry.** A flat `key → class(es)` map of single keys
   (operators/motions/text-objects/actions, + wildcard terminals). This is the
   two-layer keymap (the dumb "what keys mean" table); it is runtime-extensible.
   Multi-key commands (`iw`, `gg`, `f<char>`) are **grammar productions** —
   `('i'|'a') symbol(textobject-id)`, `'g' symbol(g-namespace-id)`, `'f' literal`
   — i.e. *sequences of registry lookups*, **not** trie-registered keystroke
   sequences. (Browser engines like Vimium use a trie *instead of* a grammar
   because they have no composition; IdeaVim uses a trie *plus* a builder; we
   fold that job into the grammar since we have one.) `acceptableNext`/which-key/
   conflicts come from the grammar's precomputed first/next-sets (§Incremental
   recognizer), not a trie.
2. **Composition = a general, fully-definable *declarative* substrate**, with
   **paradigm helpers as the front door.** The substrate is the matcher set below;
   the helpers — `operatorPending(...)`, `prefixArg(...)`, `selectionFirst(...)` —
   are high-level constructors over it, so a vim preset is `operatorPending()` +
   registered motions, a few lines, no BNF. The paradigm helper is exactly what
   *publishes the selectors* (`operatorPending` publishes `mode=operator` /
   `operator=d`). Novel paradigms drop to the base matchers.
3. **Genuinely-dynamic input = the external sub-session** (§Sub-sessions), not the
   grammar.

**Constraint (load-bearing): the substrate stays declarative, never arbitrary
imperative functions.** The static-analysis wins (`acceptableNext`, which-key,
conflicts) exist *because* the grammar is statically walkable. "Fully definable"
means any *declarative* grammar, not opaque transition callbacks — those would
lose the next-set computation (the generator problem the red-team killed).
Anything needing imperative/async behavior uses the external sub-session.

The base matchers (tier 2 substrate):

- `count` — optional leading `[1-9][0-9]*`, accumulates a number.
- `register` — `"` then a literal.
- `symbol(class)` — match a keymap-resolved token of `class`.
- `literal(name)` — capture any next key as a named argument (`f`/`t`/`r`/`m`).
- `subMode(grammar)` / `subSession(kind)` — descend into a sub-mode or yield to an
  external surface (escape hatch); see §Sub-sessions.
- `ref(rule)` — recurse (operator operand = a "target" rule).
- `choice(...)`, `optional(...)`, `repeat(...)`.

Each matcher may set `onDeadEnd: 'eat' | 'yield' | 'resolve'` to override the
default eat-vs-yield outcome (below) for the rare case the default is wrong.

Vim normal mode, sketched:

```
command := register? count? ( operatorCmd | namespaced | motion | action )
operatorCmd := operator ( doubledSelf | count? target )      // dd | d2w | d i (
target      := motion | textobject | literalMotion | searchMotion
literalMotion := ('f'|'t'|'F'|'T') literal(char)
searchMotion  := ('/'|'?') externalOperand(search)           // HP3 parked; value → motion.arg
textobject  := ('i'|'a') symbol(textobject-id)
namespaced  := ('g'|'z') symbol(namespaced-id)
```

`doubledSelf` = the operator's own key repeated → linewise.

### Incremental recognizer (HP2)

The engine drives the grammar one key at a time over a parse stack. After each
key it returns exactly one of:

- **Resolved** — a complete command; emit the structured `Command`, clear state.
- **Pending** — a valid partial parse; show the modeline, keep state.
  (Operator-pending and counts deliberately don't time out; chord-style
  prefixes keep the 1 s cancel — carried over.)
- **Cancelled (eat)** — mid-parse and the key can't continue → eat it
  (`preventDefault`). Maps onto today's `chordCancelled`.
- **Unmatched (yield)** — at a fresh start and the key can't begin any
  production → yield to native input. Maps onto today's `unmatched`.
- **Suspended** — paused for an external sub-session (escape hatch only;
  §Sub-sessions). Default sub-modes do *not* suspend.
- **composing** — IME (carried over).

**Eat-vs-yield = a per-mode default + the innermost in-progress frame's policy.**
The dead-end policy comes from the **innermost frame**, not from a `choice` (at a
dead end nothing continues, so "which alternative" is a non-question — one active
parse path, one policy). Defaults are set by the mode's paradigm helper:

- *At a fresh start*: key ∉ the grammar's FIRST-set → **Unmatched/yield**.
- *Mid-parse, dead end*: apply the innermost frame's policy —
  - `operatorPending` (normal/visual) → **eat** (`Cancelled`).
  - `prefixArg` / insert → **yield** (type the key).
  - `count` → **resolve**: complete the count consuming *no* key, then re-feed the
    key from a fresh start with the count applied (what the current engine does by
    falling through). This is why count "needs no special interrupt."
- key ∈ continuation → **Pending** or **Resolved**.

`onDeadEnd: 'eat' | 'yield' | 'resolve'` overrides per production. **`'resolve'`
is valid only where completing the frame yields a safe command** (count,
prefix-arg); it is **forbidden where it would commit a destructive incomplete
command** (a bare operator must never resolve to "delete nothing").

> **Correction (red-team).** The earlier "data-loss bounded by mode / insert has
> no mid-parse states" claim was **false** — insert has `C-r{reg}`, `C-o`, `C-v`,
> `C-k`, `C-x`. Safety comes instead from insert's **yield** dead-end policy: a
> stray key mid-`C-r` *types*, never eaten.

`acceptableNext(state)` powers eat-vs-yield, which-key, and the lexer demand. Its
contract precisely: the **class-level** next-set is pure and precomputed from the
grammar's first/follow-sets; **key-level** membership is resolved live against the
(remappable) registry, so it is pure only relative to a keymap snapshot; under
`Suspended` it is undefined (empty next-set).

**Modeline** = an **in-order traversal** of the parse stack with **positional
(pre-child / post-child) fragments**, not a flat fold — so `"a2d3w` renders in
source order (register, count1, operator, count2, motion) across recursion, which
a single-fragment-per-frame `map().join()` cannot. Surfaced via `getState()`.

### Recognizer architecture (settled)

The recognizer is an **explicit `step(state, key) → StepResult` over an
engine-owned, serializable parse stack** — **not** a generator/coroutine.

The decisive reason against generators: a generator can only signal "I want a
key"; it **cannot report the acceptable-next-set without side effects**, which
eat-vs-yield and which-key both require. A suspended generator is also opaque
and non-serializable, which breaks `peekProcessKey` snapshot/restore (already in
the engine) and dot-repeat. An explicit parse stack is plain data: snapshottable
(subsumes `EngineSnapshot`'s count/operator state — the prefix-chord overlay+timer
move to the binding layer, see §Before slice 1), table-testable without UI mocks,
and serializable for repeat/macros.

**Decouple the author API from the engine via compile-down.** Authors write the
declarative substrate combinators (§Grammar tier 2, usually via the paradigm
helpers); a compile step lowers them to a flat `CompiledGrammar` table the
pushdown recognizer interprets, and *precomputes* first/next-sets (exactly the
query generators can't answer). This keeps authoring
ergonomic (and even allows a generator-*styled* authoring DSL later, since it's
walked statically, never run at parse time) while the engine stays explicit and
analyzable. A data-table grammar is also serializable, enabling non-code presets
later without touching the engine.

Sketch:

```ts
type Token =
  | { kind: 'symbol'; class: string; id: string }
  | { kind: 'literal'; key: KeyStr }

type StepResult =
  | { outcome: 'resolved'; command: Command }
  | { outcome: 'pending'; state: ParseState }
  | { outcome: 'cancelled' }      // eat
  | { outcome: 'unmatched' }      // yield
  | { outcome: 'composing' }
  | Suspended                      // escape hatch only

interface Recognizer {
  start(grammar: CompiledGrammar): ParseState
  step(state: ParseState, token: Token): StepResult
  /** Pure query: what to lex next + which keys are acceptable. Powers
   *  eat-vs-yield, which-key, and the lexer demand. No side effects. */
  acceptableNext(state: ParseState): {
    demand: { mode: 'symbol'; classes: ReadonlySet<string> } | { mode: 'literal' }
    whichKey: ReadonlyArray<{ class: string; id?: string; label: string }>
    canBegin: boolean
  }
  modeline(state: ParseState): string
}
// ParseState = explicit, serializable pushdown stack (frames + accumulated
// bindings: count / operator / register / captured literals).
```

### Resolved command (output contract — HP5)

Resolution yields a structured command rather than the flat
`EngineResult.{action,motion,count}`:

```ts
interface Command {
  register?: string
  count?: number                 // effective (count1 * count2)
  operator?: string              // 'delete' | 'change' | 'yank' | ...
  motion?: {
    id: string
    arg?: string                 // resolved literal / search pattern (f/t/search)
    count?: number
    searchDir?: '/' | '?'
    inclusive?: boolean          // grammar-stamped (/ ? → exclusive)
    linewise?: boolean
  }
  textObject?: { scope: 'i' | 'a'; id: string }
  linewise?: boolean             // operator doubling
  action?: string                // non-operator commands
}
```

`Command` **captures resolved values, never keystrokes** — dot-repeat of
`d/foo<CR>` re-runs the *resolved pattern* `foo` (`motion.arg`) non-interactively;
it must not re-open the prompt. Any sub-session/literal result must be
representable as plain data inside `Command`, and no parse-time state (session id,
continuation) ever leaks into it.

**Wrap, not replace.** `EngineResult` keeps its existing discriminant; the
resolved variant carries `command?: Command`. A flat→structured *replacement*
would churn every call site for a benefit that lands late, so it stays
**additive** — consumers that don't do dot-repeat ignore the field.

**Dot-repeat / macros.** The engine tracks the last **recordable** `Command` and
exposes a **replay primitive** (re-dispatch it through remap → handler); the
consumer wires `.` to it. "Recordable" is a **flag on registered commands**
(changes recordable, pure motions/navigation not), so vim's `.`-repeats-last-
*change* falls out and Kakoune/Helix's `.`-vs-`Alt-.` split is just two
recordable-sets (consumer policy, not engine-baked). The engine can't see buffer
text, so for inserts the **consumer supplies the recorded text payload** (Zed's
`observe_insertion` model), stored alongside the `Command`. Visual ops record
selection **geometry** (Zed's `RecordedSelection`), not the interactive selection,
so a repeat replays by shape (detail with HP4).

## Sub-sessions and sub-modes (HP3)

> **PARKED / SUPERSEDED.** This section is the earlier *engine-owned-buffer*
> sketch. `d/foo` composition is parked (the "session-mount-is-the-cancel"
> contradiction). The leading direction is an **app-owned session** — the host
> owns the search surface (like quite-app's `HistorySearchKeyboardScope`), the
> engine holds a **persistent parse stack** across it (it must *not* auto-clear
> on the host mounting its scope), and the result is fed back as a structured
> motion. The field survey confirms this: every engine (VSCodeVim, CodeMirror,
> IdeaVim, Zed, vim-mode-plus) simply keeps the parse state alive across the
> sub-session. Literal capture (below) is unaffected. Revisit when unparked.

Two distinct mechanisms, discriminated by **who produces the next operand**:

### Literal capture — engine reads the next key itself
`f`/`t`/`r`/`m`/`"` consume the next raw `KeyStr` (the `literal(name)` matcher).
Stays in-grammar, statically analyzable, no UI; `f<Esc>` cancels just the `f`
per the dead-end policy. **Not** a 1-key sub-session — input ownership differs.

### Sub-session — an engine-owned sub-mode (the default)
A search prompt is just a tiny modal line-editor (type, Backspace, `C-w`/`C-u`,
history, Enter accepts, Escape cancels) — exactly what the grammar engine is
for. So `/` **pushes a built-in line-input sub-mode (a grammar)**; the engine
owns input capture, the buffer, and editing. `d/foo<CR>` is ordinary grammar
composition: `operator → target → searchMotion → subMode(lineInput); on <CR>,
value = buffer → motion.arg`. No suspend/resume continuation in the default case
— the parse descends and pops, value flowing upward like any production result.

The **consumer's entire surface** is:
1. render the engine's current buffer string somewhere (semmap renders no
   pixels), and
2. provide a normal `search` *handler* that resolves a pattern to a match — same
   handler model as every other action.

Editing obeys the active keymap, so a vim user gets vim editing in `/` and an
emacs user gets emacs editing, for free and consistently.

#### Live highlighting (incsearch) — one-way
The consumer must be able to highlight matches as the pattern is typed
(including operator-aware preview for `d/foo`). It rides the `subscribe`/
`getState()` pattern, but is **not** free: it requires adding `subInput` to
`EngineState`, changing `notify()`'s dedupe key (today it short-circuits on the
`pendingDisplay` string), and `getState()`'s cache. (Parked with HP3.) The shape:

- Surface sub-input on the snapshot:
  `EngineState.subInput = { kind, direction, buffer, command? }`, present only
  while the sub-mode is active. `command` carries the held parent context
  (pending operator / count / register) for operator-aware preview.
- **Per-keystroke event = the existing `notify()`**: the consumer's existing
  zero-arg `subscribe(() => …)` callback fires on each buffer edit, reads
  `getState().subInput.buffer` (+ `.command`), and highlights. Whole-string
  pull, matching every other notifier (`subscribe`/`getState`,
  `subscribeLayoutMap`). No payload-callback style.
- **Accept/cancel ride the normal output**: accept → `processKey` returns the
  resolved `Command` (`motion.arg = pattern`) and `subInput` clears; cancel →
  eaten and `subInput` clears. No bespoke `onAccept`/`onCancel`.
- **The consumer owns revert state** (cursor/scroll): snapshot when `subInput`
  appears, restore when it disappears *without* a `Command`. The engine has no
  cursor/scroll concept and must not grow one; it reverts only its own buffer.
- **One-way**: engine emits buffer/context changes; the consumer highlights /
  scrolls / runs its own `search`. The engine never needs match positions back.
- **dot-repeat/macros never push the sub-mode** → no `subInput`, no preview; the
  resolved pattern just runs.

Gotchas: the *consumer* debounces its own search (the engine fires synchronously
per key); tolerate half-typed invalid regexes; `hlsearch`-style overlays persist
on accept, clear on cancel; cap all-match highlighting to the viewport on large
documents.

### External suspend/resume — the escape hatch
For surfaces the engine genuinely cannot model as a keymap-driven sub-mode (a
fuzzy file-picker filtering the filesystem, an async completion popup), the
`subSession(kind)` matcher emits a `Suspended` outcome carrying `{ id, kind,
prompt, commandSoFar }` + `resume(value)` / `cancel()`, closing over plain
parse-stack data (not a generator frame). While suspended, `processKey` is inert
(returns the same `Suspended`); only `resume`/`cancel` advance (rule R-SUSPEND).
`cancel()` aborts the whole command (operator + count + register), returns
`Cancelled`. A stale `resume` after reset/mode-swap is a safe no-op. This is the
*exception*; engine-owned sub-modes are the default.

## Modes (HP4)

A mode is `{ keymap-ref, grammar }`. The keymap can be **shared** across modes
that classify keys the same way: `normal` and `visual` reference the *same*
keymap (`w`→motion, `d`→operator identically) and differ only in **grammar** —
`normal` = `operatorPending`, `visual` = `selectionFirst` — so motions aren't
duplicated. `insert` is a *different* keymap (`w` types "w") with the trivial
grammar. So HP1's "one keymap per editor mode" is really **one keymap per
*classification*, one grammar per mode.** Operator-pending and counts are
*positions within* normal's grammar, not modes. This replaces the consumer's
`{ id, type, keymap }` wrapper (and the synthesized prefix-mode registry) entirely.

**Visual mode = the `selectionFirst` grammar** over the shared normal registry:
the selection already exists, motions *extend* it, an operator applies
*immediately* to it (noun-first). vim is thus multi-paradigm — `operatorPending`
in normal, `selectionFirst` in visual — validating the HP6 paradigm-helpers.

- **Mode transitions are recognizer-driven.** `v`/`V`/`C-v` resolve to a
  mode-change command publishing `mode=visual` (+ a selection-kind: char/line/
  block); the new mode's `{keymap, grammar}` activates. Escape / an applied
  operator publishes `mode=normal`. The engine owns the mode *state*; the grammar
  drives the switch.
- **The selection is consumer-owned** (buffer state); the engine never owns
  selection geometry. Visual `Command`s carry intent — `{ motion: w,
  visualExtend: true }`, `{ operator: delete, onSelection: true }` — and the
  consumer's handler extends/operates on its own selection.
- **Dot-repeat replays by recorded geometry** (the HP5 hook), not by re-running
  the interactive selection (Zed's `RecordedSelection`).

## Scope / binding resolution (HP7 — direction)

The binding layer (§Two layers) resolves a key against the active `ScopeStack`.
Adopt the best of Zed's keymap engine, minus its complexity:

- **Ranked candidate list, not a single winner.** The scope walk yields an
  *ordered list* of candidate handlers; the first live / non-`propagate` one
  wins. This **subsumes `claimsInput`** (the floor = truncating the candidate
  list below a scope) and gives clean fall-through for free.
- **Explicit-stack precedence, NOT Zed's depth-of-deepest-match.** semmap's
  `ScopeStack` is already an explicit ordered stack, so stack position *is*
  precedence — unambiguous, and it avoids the confusion Zed hit (it had to change
  `>`/`!` predicate semantics in v0.197). Do **not** adopt Zed's `>` tree
  operator; the linear stack already encodes the tree.
- **Override-as-data.** `null`/`Unbind`-style disables evaluated by the same
  precedence machinery (disable a key in one scope without deleting it), plus
  source-tagging so user bindings beat preset beat default at equal precedence.
- **Selectors over flags.** Scopes/bindings may gate on selectors the grammar
  publishes (§Two layers) — e.g. a binding active only when `operator=d` — so a
  scope expresses conditional bindings without spawning a sub-scope.

How the grammar fits: the recognizer sits above the binding layer; a resolved
`Command`'s action/operator ids flow through the existing per-scope `remap` then
handler walk, unchanged. The grammar owns only the compositional
(operator/motion/count) structure.

**Prefix chords** (emacs-style `C-x C-f`) stay **keymap structure** resolved by
the binding layer — flat lookups, no counts/operators — built by a `weaveChord`
construction that weaves a chord into a keymap and is **conflict-checkable at
build time** (chord-shadow: a prefix shadows a flat binding; fan-out: one key
bound to two actions). This replaces quite-app's `applyChordToMode` and its
fragile synthesized `prefix:…@…` id coupling. A prefix continuation is just
another keymap lookup at a position, so chords and the compositional grammar
coexist cleanly.

## Relationship to other work

- **Prefix chords / `weaveChord`** — the build-time prefix-keymap construction +
  conflict detection lives in the binding layer; see §Scope/binding resolution.
- **Local `Mode` cleanup** (interim PR #1058): subsumed. With modes carrying a
  grammar, the synthesized prefix bookkeeping and the `Mode.type` flag are gone.
- The "grammar reducers" idea is this spec's small case: a reducer = a one-rule
  accumulator grammar. No separate mechanism needed.

## Before slice 1: implementation contracts

The design is essay-coherent, but these contracts must be pinned before code
(final red-team). They are slice-1-blocking unless noted.

### `acceptableNext` — first-set closure over the parse stack

Returns the first-set **closure over the runtime parse stack**, not one node. From
the top frame's current matcher, include its first-set; if that matcher is
skippable (`optional`/`repeat`/already-satisfied), fold in FOLLOW (the next matcher
in the frame, and up through parent frames if those are skippable too). Predictive
first/follow evaluated over the live stack (small depth).

```ts
acceptableNext(state): {
  demand: { kind: 'symbol'; classes: ReadonlySet<Class> } | { kind: 'literal' }
  whichKey: ReadonlyArray<{ key: KeyStr; class: Class; id: string; label: string }>
  canBegin: boolean   // fresh start → a miss yields; else a miss eats (innermost-frame policy)
}
```

**Demand is singular** — `symbol(classes)` XOR `literal`, never mixed, because
alternatives at one position never mix registry-lookup with raw-capture (forbid
`choice(symbol, literal)`; vim never needs it — `f`-then-char is two positions).
`classes` = the union of first-classes across the closure.

**Three-layer static/live split** (this is the precomputed-vs-live answer):

1. *Structure — static, compiled.* Per-position first/follow **of classes** +
   the FOLLOW closure. This is all "precompute first/next-sets" means: class-level
   only, never key-level.
2. *Key→class membership — live.* Joined against the remappable registry at query
   time.
3. *Key-identity guards — live.* `0`-count and `doubledSelf` are
   **`keyGuard(pred, production)`** matchers, `pred` a pure boolean over
   `(parseState, key)` (e.g. `sameAsPendingOperator`→doubling,
   `countInProgress`→the `0` rule). The compiled table marks guarded positions;
   the interpreter evaluates the guard live. A guard *reads* parse state and never
   consumes input, so it is **not** the opaque transition-callback the recognizer
   forbids. (Open: closed named-predicate set vs. arbitrary pure predicate — lean
   named set for serializability.)

So the honest contract is **`acceptableNext` is pure over `(parseState,
registry-snapshot)`** — a pure function, not a precomputed constant.

Worked traces: *fresh normal start* → FIRST(command), `0` is the col-0 **motion**
(`countInProgress` false); *operator-pending* → `{pending-op-key→doubling, digits,
motion, i/a→textobject-scope, f/t, / ?}`, unbound key → eat; *inside count* → `0`
is now a **digit** (`countInProgress` true), `d` continues to the command;
*after `i`* → FIRST(`symbol(textobject-id)`); *mid-`f`* → `demand=literal`, Escape →
cancel.

### `Command` → dispatch (slice-1 change)

A resolved `Command` dispatches by routing its **primary id** (the operator id;
else the action / bare-motion id) through the existing per-scope `remap → handler`
walk, with the **structured `Command` as the handler args**. So `ActionArgs` grows
from `{count?, motion?}` to `{register?, operator?, motion?:{id,arg,count,…},
textObject?, linewise?, count?}`, and `HandlerFn` receives it. Since slice 1 ships
text objects + `f`/`t` args, this `ActionArgs`/`HandlerFn` change is **slice 1**,
not later.

### Parked HP3 is *out of* the slice-1 type surface

Slice-1 `StepResult` = `resolved | pending | cancelled | unmatched | composing` —
**no `Suspended`**. The slice-1 matcher set **excludes** `subSession` /
`externalOperand`. So slice-1 `ParseState` carries **no survives-scope-mount
invariant** and keeps today's clear-on-scope-change behavior
(`onKeymapSourceChanged`). The held-frame lifetime is designed when HP3 is unparked
(its own slice), never bolted onto slice 1.

### Snapshot across two layers

`ParseState` subsumes the **count/operator/universalArg** part of `EngineSnapshot`;
the **prefix-chord overlay + 1 s timer** move to the **binding layer** (they're
keymap structure, §Scope/binding). `peekProcessKey` / snapshot-restore composes
both: `snapshot = { parseState, bindingState }`.

### Mode-transition ownership

The **engine owns mode state** and flips the active `{keymap, grammar}` when it
*resolves* a mode-change command — **before** the handler walk — and also emits the
command so the consumer updates its selection/UI. So: engine flips mode → emits →
consumer handles (UI/selection side-effects). Mode = engine state; selection =
consumer state; no ambiguity.

## Staging

Land in slices, each shippable:

1. **Core (split for bisectability):**
   - **1a.** Recognizer (explicit step + serializable `ParseState`) +
     `acceptableNext` closure + `Command` output + `ActionArgs`/`HandlerFn` growth
     + **wrap** `EngineResult` (additive `command?`). Port `count` + simple
     actions + the emacs universal-arg grammar.
   - **1b.** `operator` + `motion` + multiplied counts + doubling (`keyGuard`).
   - **1c.** Text objects (`choice` + selector-gating) + literal capture
     (`f`/`t` + the `literal` matcher + dead-end-cancel).
   Move vim/emacs grammar out of the core into presets across 1a–1c.
2. **Namespaces & arguments.** `g`/`z` prefixes, registers `"`, marks `m`/`` ` ``.
3. **Search / `d/foo` composition (HP3 — parked).** App-owned session with a
   persistent parse stack across it; resolved value → `motion.arg`. Unpark and
   settle the held-frame lifetime before building.
4. **Visual mode** grammar. (HP4)
5. **Repeat/macros** on the structured `Command`.

## Open questions

1. ~~Combinators vs data table~~ **Resolved (HP6):** registry of terminals +
   declarative substrate (combinators) that **compile down** to a serializable
   grammar table; first/next-sets precomputed. See §Grammar.
2. **Search-UI boundary (HP3 — parked).** Leading direction: app-owned session
   (host owns the surface) + a persistent parse stack across it. The engine-owned
   line-input sketch in §Sub-sessions is superseded.
3. ~~Lexer ambiguity~~ **Resolved (HP1):** flat key→class registry (shareable per
   classification, HP4); the grammar's `choice` selects the class; no
   per-parse-state keymaps; doubling is a grammar rule, not a keymap entry.
4. ~~`Command` vs. thin `EngineResult`~~ **Resolved (HP5):** wrap — additive
   `command?: Command` on the existing discriminant; engine tracks last recordable
   command + replay primitive; consumer supplies insert-text payload; visual ops
   record geometry. See §Resolved command.
5. ~~Visual mode~~ **Resolved (HP4):** `selectionFirst` grammar over the shared
   normal keymap; recognizer-driven mode transitions (publish `mode=visual` +
   selection-kind); consumer-owned selection; geometry-based repeat. See §Modes.
6. ~~Scope-stack / remap seam~~ **Direction set (HP7):** ranked candidate list
   (subsumes `claimsInput`), explicit-stack precedence (not Zed's depth model),
   override-as-data, selectors-over-flags. See §Scope/binding resolution.
7. ~~Author surface (HP6)~~ **Resolved:** registry of terminals + general
   declarative composition substrate + paradigm helpers + external escape hatch
   (declarative-only recognizer). See §Grammar.
