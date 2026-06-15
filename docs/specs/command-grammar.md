# Spec: Command grammar (a grammar over keystrokes)

Status: proposed — design resolved; HP3 (`d/foo` composition) parked as a
deferrable feature-slice. Ready for slice 1a.
Owner: —
Related: `KeyboardEngine`, `EngineResult`, `EngineState`, `EngineSnapshot`,
`ScopeStack`, `Dispatcher`, presets/vim, presets/emacs.

## Summary

Put a **command grammar** in the core engine: an incremental recognizer that
turns a stream of keystrokes into a **structured command**. The grammar is
productions over **key terminals**; vim and emacs are grammar *presets*, not
hardcoded engine state. semmap imposes **no command taxonomy** — "operator",
"motion", "text object" are names a preset's grammar defines, not engine
concepts. This is what makes real vim grammar (text objects, `f<char>`,
registers, multiplied counts, operator doubling, `g`/`z` namespaces, search,
visual) expressible at all.

## Goal (judge every decision against this)

**Make building an evil-mode-class modal input scheme easy for a consumer** — a
declarative grammar *definition* over a shared in-core recognizer, not a
hand-rolled parser. evil-mode is thousands of lines of bespoke recognizer in Lisp
*precisely because* emacs's core offers no grammar; that effort is the pain this
work eliminates. Success = a consumer expresses vim-class grammar (and
emacs-class, and its own) as a grammar definition and gets static analysis
(conflicts, which-key) and dot-repeat for free.

"Keep the core minimal / paradigm-neutral" is a real value, but **secondary**:
where it conflicts with making rich grammars easy to define, *easy wins*. Control
over opinionated semantics is served by making the **grammar definition**
swappable — never by keeping the recognizer out of the core, and never by baking
a specific editor's command types into the engine.

## Motivation

Today the engine resolves keys through a keymap plus ad-hoc overlays
(operator-pending, prefix-chord) and accumulator fields (`countAccum`,
`operatorPending`/`operatorCount`, `universalArg`). Real vim normal mode needs
constructs none of those express: literal-capture terminals (`f<char>`, `r`,
`m`, registers), multiplied counts (`2d3w`), operator doubling (`dd`), text
objects (`diw`), search-as-motion (`d/pat<CR>`), `g`/`z` namespaces, visual mode,
and `.`-repeat (which needs a *parsed command*, not an action id).

These are all **grammar**, and the grammar belongs in the core: resolving
stateful multi-key input into commands *is* the engine's job and its value.
emacs is the cautionary case — it has no grammar in its core, so every rich
input scheme (evil-mode, hydra, god-mode) rebuilds the machinery in Lisp.
Putting the recognizer in the core makes "define a grammar easily" a real
library capability and keeps input statically analyzable. vim and emacs become
grammar presets; the engine stays grammar-agnostic.

## Model

```
key → recognizer.step(state, key) → StepResult
        a matched terminal emits its effect (accumulate / capture / advance / resolve)
        no match → eat (mid-parse) | yield (fresh start)
        Resolved → structured Command → remap / handler (existing scope walk)
```

### Two layers: grammar publishes, binding layer dispatches

The engine is two layers with a one-way interface (validated against Zed's keymap
engine):

1. **Grammar layer** — the incremental recognizer. The authority on modal state:
   counts, pending operator, register, composition, dot-repeat. It *publishes
   selectors* (`mode=operator`, `operator=d`, a pending count).
2. **Binding layer** — a dumb, declarative, selector-gated dispatch table (the
   mode stack's layered keymaps, §Modes) that resolves a key to a group/action and
   knows nothing about composition.

Interface: **grammar → publishes selectors → binding layer reads them.** This is
how Zed handles operator-pending (one keymap, no swap; bindings predicate on
`vim_mode`/`vim_operator`). It keeps modal state *out* of the binding layer.
semmap should be richer than Zed here: a typed grammar keeps the count numeric
and the structure intact, where Zed flattens count to a boolean and uses
stringly-typed `waiting`/`literal` overrides.

### Terminals and grouping (no class/kind/lexer)

A grammar is **productions over key terminals**. There is no lexer, no
token-type, no command "kind." A key is just a terminal; the grammar's
*structure* groups keys via **author-defined nonterminals** — e.g. the vim
preset writes `motion := w | b | $ | …`, `operatorCmd := operator target`. "Which
keys are motions" is the membership of the `motion` rule — provided by the
**layered mode-stack keymaps** (§Modes), so it is per-mode and scope-overridable,
not a flat global registry. There is no separate kind-tagging layer.

Consequences:

- semmap imposes **no command ontology**. `operator`/`motion`/`textobject` are
  names in the vim preset's grammar; a different preset has different groups.
- Polysemy is just different bindings in different contexts: `i` is in the
  `action` group of insert mode's grammar and the `textobject-intro` group at an
  operator's operand position. At any one position `i` is one thing.
- Modes that classify keys the same way **share** terminal-group definitions:
  `normal` and `visual` share `motion`/`operator`; `insert` differs (`w` types).
- Determinism and conflicts are pure properties of the grammar (below) —
  FIRST-sets are over **keys**, checkable directly; a remap re-runs the check.

### The grammar (author surface)

Three tiers, so the easy cases are easy and the hard cases stay possible:

1. **Terminals + groups = the registry.** Keys, and the author-defined groups
   (`motion`, `operator`, …) the grammar references. Group membership is the
   binding config and is runtime-extensible.
2. **Composition = a general, fully-definable *declarative* substrate**, with
   **paradigm helpers as the front door** — `operatorPending(...)`,
   `prefixArg(...)`, `selectionFirst(...)`. A vim preset is `operatorPending()` +
   its groups, a few lines, no BNF. The helper is what *publishes the selectors*
   (`operatorPending` publishes `mode=operator`/`operator=d`). Novel paradigms
   drop to the base matchers.
3. **Genuinely-dynamic input = the external sub-session** (§Sub-sessions), not
   the grammar.

**Constraint (load-bearing): the substrate stays declarative — no arbitrary
imperative functions.** Conflict-detection and which-key exist *because* the
grammar is statically walkable. "Fully definable" means any declarative grammar,
not opaque transition callbacks (the generator problem). Imperative/async
behavior uses the external sub-session.

Base matchers (tier-2 substrate). **Each carries the effect it emits when it
matches** — syntax-directed:

- `key(k)` / `group(name)` — match a specific key / any key in a named group.
- `literal(name)` — a **wildcard terminal**: match *any* next key and capture it
  as a named argument (`f`/`t`/`r`/`m`/register). (This is "literal capture" —
  it's just a terminal that matches anything; there is no separate "lexer
  demand.")
- `count` — accumulate a leading number (emits onto the command's count).
- `keyGuard(pred, production)` — a production gated by a **pure boolean over
  `(parseState, key)`** drawn from finite-domain registers (e.g.
  `sameAsPendingOperator`→doubling, `countInProgress`→the `0` rule). The guard
  *reads* parse state, never consumes input.
- `ref(rule)`, `choice(...)`, `optional(...)`, `repeat(...)`, `seq(...)`.

Each matcher may set `onDeadEnd: 'eat' | 'yield' | 'resolve'` to override the
default (below) for the rare case it's wrong.

Vim normal mode, sketched (illustrative — `searchMotion` is HP3-parked):

```
command     := register? count? ( operatorCmd | namespaced | motion | action )
operatorCmd := operator ( doubledSelf | count? target )
target      := motion | textobject | literalMotion | searchMotion
literalMotion := ('f'|'t'|'F'|'T') literal(char)
textobject  := ('i'|'a') group(textobject-id)
namespaced  := ('g'|'z') group(namespaced-id)
doubledSelf := keyGuard(sameAsPendingOperator, → linewise)
```

### The recognizer: `step` is the core

The recognizer is `step(state, key) → StepResult`. It tries to match the key
against the terminals reachable at the current parse position; **the matched
terminal emits its effect** (accumulate / capture / advance the parse / complete
the command). After each key it returns one of:

- **Resolved** — a complete command; emit the structured `Command`, clear state.
- **Pending** — a valid partial parse; keep state, update the modeline.
  (Operator-pending and counts don't time out; chord-style prefixes keep the 1 s
  cancel.)
- **Cancelled (eat)** — mid-parse, no terminal matched → eat the key
  (`preventDefault`). Maps onto today's `chordCancelled`.
- **Unmatched (yield)** — at a fresh start, no production can begin → yield to
  native input. Maps onto today's `unmatched`.
- **Suspended** — escape-hatch sub-session only (§Sub-sessions); *not* in
  slice 1.
- **composing** — IME (carried over).

**Eat-vs-yield falls out of `step`** — there is no separate query: a key that
matches a terminal advances; a key that matches nothing is a dead end, resolved
by the **innermost in-progress frame's policy** (at a dead end nothing continues,
so it's one active path, one policy):

- `operatorPending` (normal/visual) → **eat**.
- `prefixArg` / insert → **yield** (type the key). (Insert *does* have mid-parse
  states — `C-r`/`C-o`/`C-v`/`C-k`/`C-x` — so safety comes from this yield
  policy, not from "insert has no mid-parse states.")
- `count` → **resolve**: complete the count consuming *no* key, then re-feed the
  key from a fresh start with the count applied (what the engine does today by
  falling through). This is why count "needs no special interrupt."

`onDeadEnd: 'resolve'` is valid only where completing the frame yields a *safe*
command (count, prefix-arg) and **forbidden** where it would commit a destructive
incomplete command (a bare operator must never resolve to "delete nothing").

**Modeline** = an in-order traversal of the parse stack with positional
(pre-child / post-child) fragments — so `"a2d3w` renders in source order. (Each
matched terminal already emitted its fragment; this just orders them.)

**which-key is optional and derived.** It is the *only* consumer that needs
"what's valid next" *without* a key, so it's an introspection — `enumerate(state)`
→ the keys reachable at the current position (the FIRST-set over the live group
membership) with labels. It is **not in the hot path** and not required by the
core loop. Conflicts are caught at compile time (below), not at runtime.

### Recognizer class (formal)

A **deterministic pushdown recognizer, online over the keystroke stream, with
zero lookahead**:

- **online / one key per step** — each key triggers one step that *decides and
  consumes* it. No peek, no buffered key ahead — so operationally **no
  lookahead** ("LL(1)" names this grammar class, but the "1" is an offline-parser
  artifact; here the key is the current input, decided on arrival).
- **deterministic** — `(configuration, key) → a unique transition`, or a dead
  end. **No backtracking, no look-back.**
- **real-time** — O(grammar-depth) work per key (no left recursion / nullable
  cycles).
- **pushdown** — the parse stack carries the shallow command nesting.

State registers (operator, count, register, captured literals, last-find) are a
**forward accumulator**. A `keyGuard` affecting control flow reads only
**finite-domain** registers, so the guarded grammar **expands to a finite
ordinary grammar** — guards add no power. Unbounded values (count value, captured
char, search pattern) are **data attributes synthesized onto the `Command`; they
never gate a production.**

**Admissibility — compile-time, rejectable.** With every `keyGuard` expanded over
its finite domain, a grammar is admissible iff, over its **key** terminals:

1. **FIRST/FIRST disjoint** — alternatives at every choice share no first-key.
2. **FIRST/FOLLOW disjoint** — for every nullable element (`count?`, `optional`,
   `repeat`), FIRST ∩ FOLLOW = ∅.
3. **No left recursion, no nullable cycles** (real-time).
4. **Guards finite-domain and mutually exclusive** at a shared choice.
5. **No unbounded value gates a production.**

Because FIRST-sets are over **keys**, determinism is a pure property of the
grammar: a key matches at most one terminal at any position, so the recognizer
never buffers, peeks, or backtracks. **A remap is just editing group membership,
which re-runs this check.** There is no class-vs-key gap and no
remappable-registry hazard. (The lone deliberate overlap is `0`: bound in the
`motion` group, claimed mid-count by the `countInProgress` guard — one explicit
precedence, not a general one.)

### Resolved command (output)

```ts
interface Command {
  register?: string
  count?: number                 // effective (count1 * count2)
  operator?: string
  motion?: { id: string; arg?: string; count?: number;
             searchDir?: '/' | '?'; inclusive?: boolean; linewise?: boolean }
  textObject?: { scope: 'i' | 'a'; id: string }
  linewise?: boolean             // operator doubling
  action?: string
}
```

`Command` **captures resolved values, never keystrokes** — dot-repeat of `d/foo`
re-runs the *resolved pattern* non-interactively; no parse-time state (session id,
continuation) leaks in.

**Wrap, not replace.** `EngineResult` keeps its discriminant; the resolved variant
carries `command?: Command` (additive — non-dot-repeat consumers ignore it).

**`Command` → dispatch (slice-1 change).** A resolved `Command` dispatches by
routing its **primary id** (operator id; else action/bare-motion id) through the
existing per-scope `remap → handler` walk, with the structured `Command` as the
handler args. So `ActionArgs`/`HandlerFn` grow to carry `{register?, operator?,
motion?, textObject?, linewise?, count?}`. Since slice 1 ships text objects +
`f`/`t`, this is a slice-1 change.

**Dot-repeat / macros.** The engine tracks the last **recordable** `Command`
(recordable is a flag on the registered command — changes recordable, pure
motions not) and exposes a **replay primitive** (re-dispatch through
remap→handler); the consumer wires `.`. The engine can't see buffer text, so for
inserts the **consumer supplies the recorded text payload**, stored alongside.
Visual ops record selection **geometry**, not the interactive selection.

## Sub-sessions (HP3 — parked)

> **Parked.** Operator + interactive sub-operand (`d/foo`) — the
> "session-mount-is-the-cancel" contradiction. Leading direction: an **app-owned
> session** (the host owns the search surface, like quite-app's
> `HistorySearchKeyboardScope`), the engine holds a **persistent parse stack**
> across it (it must *not* auto-clear when the host mounts its scope), and the
> result feeds back as a structured motion. Every surveyed engine (VSCodeVim,
> CodeMirror, IdeaVim, Zed, vim-mode-plus) simply keeps the parse alive across the
> sub-session. The held-frame lifetime (what cancels it; resume/cancel/reset/
> keymap-change ordering; distinguishing the awaited session-mount from an
> unrelated scope change) is the remaining design work. **`Suspended` /
> `subSession` are out of the slice-1 type surface.**

Two mechanisms, by who produces the next operand:

- **Literal capture** (`f`/`t`/`r`/`m`/`"`) — the engine reads the next key
  itself (a `literal` wildcard terminal). In-grammar, statically analyzable, no
  UI. Slice 1.
- **External sub-session** — a surface the engine can't model (fuzzy file-picker,
  async completion): a `subSession(kind)` matcher emits a `Suspended` outcome
  carrying a resume/cancel continuation over plain parse-stack data. The host owns
  the surface; live highlighting (incsearch) is one-way via engine state the host
  reads. (Note: surfacing the live buffer for incsearch needs a new
  `EngineState.subInput` field, a change to `notify()`'s `pendingDisplay`-only
  dedupe, and `getState()`'s cache — *not* free. Parked.)

## Modes — the mode stack (HP4 + HP7)

semmap owns a **stack of modes**. A mode is `{ bindings (keymap + remaps),
optional grammar, handler-refs }`. This unifies what were two separate stacks —
the binding `ScopeStack` and the per-mode grammar — into one: every active context
carries *both* its bindings and (optionally) its composition. Prior art: emacs
**minor modes** (layered keymaps with a precedence order — the right mental model,
layered not exclusive); Cocoa's **responder chain**; Zed's **key contexts**.

The app drives the stack (push history-search when it opens, pop on close — as
`useScope` does today) and supplies the handler functions; **semmap owns** the
stack structure, precedence, selector-gating, and grammar-switching.

**Two push semantics:**
- a **base mode** is *replaced* — vim `normal` ↔ `insert` ↔ `visual`;
- **overlay modes** *push/pop* — history-search, a modal, completion.

Both layer with precedence; the **top-most mode that declares a grammar** is the
active grammar (most app modes declare none — they only add bindings).

### Resolution: the grammar sits between the keymap and remap layers

The existing `keymap → remap → handler` scope walk gains the grammar as a middle
layer:

```
key ─▶ mode-stack keymap (layered, selector-gated) → which group the key plays
       active-grammar.step(grouped-key) → Pending (publish selector) | Resolved
       Resolved ─▶ mode-stack remap → handler          (per-mode dispatch, unchanged)
```

- **Below the grammar — grouping.** The layered per-mode keymaps resolve
  `key → group` (motion / operator / action / …). This is where **precedence**
  (ranked candidate list — first live / non-`propagate` wins, subsuming
  `claimsInput` as "truncate the list below this mode"), **override-as-data**
  (`null`/`Unbind`, source-tagging user > preset > default), and **selector-
  gating** live — in operator-pending the keymap puts `i` in `textobject-intro`,
  in normal in `action`. App bindings are the same mechanism: the history-search
  mode's keymap puts `C-r` in `action` → the grammar resolves it to
  `Command{action:…}`.
- **The grammar composes** the grouped keys and **publishes selectors** the keymap
  reads on the *next* key — a **one-key lag**, no circularity (`d`'s step sets
  `operator=delete`; the next key's keymap reads it).
- **Above the grammar — dispatch** the resolved `Command` through the layered
  remaps → handlers, unchanged.
- **Precedence is explicit stack position** — not Zed's depth-of-deepest-match,
  no `>` tree operator (the stack already encodes the tree; avoids the confusion
  Zed changed in v0.197).

### Prefix chords live in the keymap layer

`C-x C-f`, `gg`, `zz` are multi-key sequences resolved *in the keymap layer* via
`weaveChord` — conflict-checkable at build time (chord-shadow: a prefix shadows a
flat binding; fan-out: one key bound to two actions) — yielding one grouped action
the grammar then sees (`3gg` works: the keymap yields `gg → motion`, the grammar
applies the count). So `g`/`z` namespaces are **keymap chords, not grammar
productions**; the grammar shrinks to pure composition. `weaveChord` replaces
quite-app's `applyChordToMode` + its fragile synthesized prefix-ids.

### Visual = the `selectionFirst` grammar

`normal` and `visual` are modes that **share** keymaps/groups (`w` is a motion in
both) and differ only in grammar — `operatorPending` vs `selectionFirst` (the
selection exists, motions extend it, an operator applies immediately). vim is thus
multi-paradigm. Transitions are recognizer-driven: `v`/`V`/`C-v` resolve to a
mode-change command; the **engine owns mode state** and switches the active mode
*before* the handler walk, emitting the command so the consumer updates its
(consumer-owned) selection. Dot-repeat replays by recorded **geometry**.

### Snapshot seam

State to snapshot = the grammar's `ParseState` + the keymap layer's pending-chord
state (overlay + 1 s timer). They're at different layers and mutually at-rest
(mid-`C-x` the keymap has pending state and the grammar's at rest; mid-`dw`
vice-versa). `peekProcessKey` composes `{ parseState, chordState }` — both plain
data.

## Before slice 1: implementation contracts

- **`step` core + `enumerate` for which-key** — above. eat-vs-yield is `step`'s
  match-or-not; literal capture is a wildcard terminal; `enumerate` is optional.
- **`Command` → dispatch** — `ActionArgs`/`HandlerFn` grow (slice-1 change), above.
- **Parked HP3 out of slice-1 types** — `StepResult` = `resolved | pending |
  cancelled | unmatched | composing`; matcher set excludes
  `subSession`/`externalOperand`; so slice-1 `ParseState` keeps today's
  clear-on-scope-change and carries no survives-scope-mount invariant.
- **Snapshot across two layers** — `ParseState` subsumes the count/operator part
  of `EngineSnapshot`; the prefix-chord overlay+timer live in the keymap layer;
  `peekProcessKey` composes `{ parseState, chordState }` (see §Modes snapshot seam).
- **Mode-transition ownership** — engine owns mode state, flips before the handler
  walk, emits for the consumer.

## Staging

1. **Core (split for bisectability):**
   - **1a.** Recognizer (`step` + serializable `ParseState`) + `Command` output +
     `ActionArgs`/`HandlerFn` growth + **wrap** `EngineResult`. Port `count` +
     simple actions + the emacs universal-arg grammar.
   - **1b.** `operator` + `motion` + multiplied counts + doubling (`keyGuard`).
   - **1c.** Text objects (`choice` over groups) + literal capture
     (`f`/`t` wildcard terminal + dead-end-cancel).
   Move vim/emacs grammar out of the core into presets across 1a–1c.
2. **Namespaces & arguments.** `g`/`z` prefixes, registers `"`, marks `m`/`` ` ``.
3. **Search / `d/foo` (HP3 — parked).** App-owned session + persistent parse
   stack; resolved value → `motion.arg`. Unpark and settle the held-frame
   lifetime before building.
4. **Visual mode** grammar.
5. **Repeat / macros** on the structured `Command` (+ `enumerate`/which-key any
   time after 1a).

## Open questions

1. **HP3 held-frame lifetime** (parked) — the hardest remaining problem; see
   §Sub-sessions.
2. **`keyGuard` predicate surface** — a closed named set vs. arbitrary
   finite-domain pure predicates (lean named set for serializability; admissibility
   forces finite domains either way).
