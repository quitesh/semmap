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

### The grammar is the keymap

There is **no separate keymap layer.** The grammar's terminal rules *are* the
key→meaning map, and a terminal emits a **semantic action id** (`w → motion.word`,
`d → operator.delete`). Recognition is the grammar; the only thing downstream is
**dispatch** — the existing per-mode `remap` (semantic → concrete) then `handler`,
unchanged:

```
key → grammar (terminals key→semantic, then compose) → Command{semantic ids}
    → remap (semantic→concrete, per mode) → handler
```

The grammar **absorbs** the keymap layer of the old `keymap → remap → handler`
split and adds composition on top; remap and handler stay as they are. Both points
of semantic rebinding survive: **key→semantic** (the grammar's terminal rules) and
**semantic→concrete** (remap, per mode). A composite `Command` carries several
semantic ids (operator + motion); remap applies to each.

This is why we **don't** need Zed's grammar/keymap split or its context-flag
"selectors": Zed threads `vim_mode`/`vim_operator` flags because its grammar is a
hardcoded enum sitting *next to* a declarative keymap. Ours is declarative and
encodes positional meaning **directly** — `i` is `textobject` because it's in the
*operand* production and `action:insert` because it's at *command-start*. Position
replaces the flag. (Polysemy → grammar position; chords → grammar productions;
gating of app bindings → the dead-end policy. All grammar.)

### Terminals: key → semantic id (no class/kind/lexer)

A grammar is **productions over terminals**, and a terminal is **`key → semantic
id`** (`w → motion.word`, `d → operator.delete`). No lexer, no token-type, no
command "kind." Keys group by **semantic namespace**: the `motion` group *is* the
terminals whose id is `motion.*`. The grammar composes by namespace (`operator.*`
then `motion.*`); grouping falls out of the semantic id, with nothing extra to tag.

Consequences:

- semmap imposes **no command ontology** — `operator`/`motion`/`textobject` are
  semantic-id namespaces a preset's grammar uses; another preset uses others.
- Polysemy is **grammar position**: `i` is `textobject`/`motion` at the operand
  position and `action:insert` at command-start — different productions, no flag.
- **Rebinding is per grammar-position** — exactly vim's `nmap`/`omap` split.
  Command-start terminals are `nmap`; operand-position terminals are `omap`;
  insert is `imap`. "Rebind `j`" is therefore *not* global — editing the
  command-start rule vs. the operand rule is the `nmap`-vs-`omap` distinction,
  *because the grammar owns what a key means after an operator*. The **grammar
  structure (composition) is preset-owned and fixed**; the **terminals
  (key→semantic, per position) are the rebindable layer**. A bare rebind defaults
  to command-start (like `nnoremap`); the operand context is rebound separately.
- `normal` and `visual` **share** terminal rules (`w → motion.word` in both);
  `insert` differs (`w → action:type-w`).
- Determinism/conflicts are pure grammar properties (below); a rebind re-runs the
  admissibility check.

### The grammar — core vs. preset/helper

Two layers, sharply separated:

**semmap core = the recognizer + base combinators.** Neutral; no editor concepts.
Each terminal emits a semantic id; each matcher carries the effect it emits when
it matches (syntax-directed):

- `key(k)` / `group(name)` — match a specific key / any terminal in semantic
  namespace `name` (e.g. `motion`).
- `literal(name)` — a **wildcard terminal**: match *any* next key and capture it
  as a named argument (`f`/`t`/`r`/`m`/register). (No "lexer demand" — it's just a
  terminal that matches anything.)
- `count` — accumulate a leading number onto the command.
- `ref(rule)`, `choice(...)`, `optional(...)`, `repeat(...)`, `seq(...)`.

A matcher may set `onDeadEnd: 'eat' | 'yield' | 'resolve'` to override the default.
**There are no state-gated matchers** — matching is purely structural (position +
key); parse-state registers are *output-only* (§Recognizer class).

**Preset/helper layer = everything editor-specific**, built from those combinators.
The paradigm helpers — `operatorPending()`, `prefixArg()`, `selectionFirst()` —
live **here, not in the core** (semmap may *ship* them next to the vim/emacs presets
as a convenience, but they're a layer on top). A vim preset is `operatorPending()`
+ its terminals, a few lines. The helper **generates** the composition grammar from
the registered set — including **operator doubling**: for each operator it emits a
structural `key(opKey) → linewise` alternative at the operand position, so doubling
follows rebinding (rebind delete to `x` → the helper re-emits `key('x')`). "Which
key is the same" is the helper's loop, run at grammar-build time; the core never
sees "doubling," only the generated `key(...)` productions.

Constraint (load-bearing): the grammar stays **declarative** — no arbitrary
imperative functions. Conflict-detection and which-key exist *because* the grammar
is statically walkable. Imperative/async behavior uses the external sub-session.

Vim normal mode, sketched (illustrative — `searchMotion` is HP3-parked; the
per-operator `key(opKey)→linewise` doubling alternatives are helper-generated):

```
command     := register? count? ( operatorCmd | namespaced | motion | action )
operatorCmd := operator ( count? target )
target      := motion | textobject | literalMotion | searchMotion
literalMotion := ('f'|'t'|'F'|'T') literal(char)
textobject  := ('i'|'a') group(textobject-id)
namespaced  := ('g'|'z') group(namespaced-id)
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
**forward, output-only accumulator** — synthesized onto the `Command` and **never
read to gate a match.** Matching is purely structural (parse position + key);
there are **no state-gated matchers, no guards.** Vim's two seemingly-stateful
rules need no state read: counts by greedy `repeat`, operator doubling by the
per-operator structural productions the preset generates (§The grammar). So the
recognizer is a **plain deterministic pushdown recognizer**, no augmentation.

**Admissibility — compile-time, rejectable.** Over the **key** terminals, a
grammar is admissible iff:

1. **FIRST/FIRST disjoint** — alternatives at every choice share no first-key,
   *except* a greedy `repeat` may share first-keys with its follow-set, resolved by
   **continue-over-exit** (this is how `count`'s `[0-9]*` claims `0` over the
   `0`-motion). This is the one defined precedence; everything else is disjoint.
2. **FIRST/FOLLOW disjoint** for every nullable element (`count?`, `optional`).
3. **No left recursion, no nullable cycles** (real-time).

Determinism is a pure property of the grammar: a key selects at most one
transition at any position, so the recognizer never buffers, peeks, or backtracks.
**A rebind is just editing terminal rules, which re-runs this check.** No
class-vs-key gap, no remappable-registry hazard, no guards.

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

semmap owns a **stack of modes**. A mode is `{ grammar, remap, handler-refs }` —
the **grammar is the bindings** (its terminals are the key→semantic map; §The
grammar is the keymap), `remap` is its semantic→concrete table, handlers are the
app's functions. This unifies what were two stacks (the binding `ScopeStack` and
the per-mode grammar): every active context carries its bindings *and* its
composition as one grammar. Prior art: emacs **minor modes** (layered keymaps with
precedence — the right mental model); Cocoa's **responder chain**; Zed's **key
contexts**.

Every mode has a grammar; most app modes (pane, modal) are **trivial** — flat
`key → action` terminals, no composition. The rich ones (vim-normal) compose. The
app drives the stack (push history-search when it opens, pop on close — as
`useScope` does today) and supplies handlers; **semmap owns** the stack,
precedence, and grammar-switching.

**Two push semantics:** a **base mode** is *replaced* (vim `normal` ↔ `insert` ↔
`visual`); **overlay modes** *push/pop* (history-search, modal, completion).

### Resolution and fallthrough

Recognition is the active grammar; dispatch is that mode's `remap → handler`:

```
key → top mode's grammar.step → Pending | Resolved(Command) | Unmatched
      Unmatched at command-start → fall to the next mode's grammar (precedence)
      Resolved → that mode's remap → handler
```

- **Fallthrough is only at command-start.** The top mode's grammar tries to begin;
  `Unmatched` falls to the next mode (stack-order precedence; `Unmatched` at the
  bottom yields to native input). Once a grammar **begins** (Pending) it owns the
  rest of the command — **mid-parse dead-ends eat, never fall through** (`d` then
  an invalid motion cancels; the key doesn't leak to another mode). So a mode's
  dead-end policy is what gates lower-mode/app bindings: reachable at a fresh start
  (fallthrough), unreachable mid-command (eat).
- **Precedence is explicit stack position** — not Zed's depth-of-deepest-match, no
  `>` tree operator. **Override-as-data** (`null`/`Unbind`, source-tagging
  user > preset > default) layers the terminal rules. (Subsumes `claimsInput`:
  truncate the stack below a mode.)
- App bindings are just terminals in the app mode's grammar (`C-r → action.search`).

### Prefix chords are grammar productions

`C-x C-f`, `gg`, `zz` are **multi-key grammar productions** (`prefix := 'C-x'
continuation`, `gg := 'g' 'g'`), not a separate keymap mechanism. Their pending
state lives in the parse stack; their conflict-checking *is* grammar admissibility
(chord-shadow and fan-out are FIRST/FIRST violations). So `weaveChord` dissolves
into the grammar + its compile-time check, and `g`/`z` namespaces are ordinary
productions (`3gg` works: the count production wraps the `gg` motion).

### Visual = the `selectionFirst` grammar

`normal` and `visual` are modes that **share** terminal rules (`w → motion.word` in
both) and differ only in composition — `operatorPending` vs `selectionFirst` (the
selection exists, motions extend it, an operator applies immediately). vim is thus
multi-paradigm. Transitions are recognizer-driven: `v`/`V`/`C-v` resolve to a
mode-change command; the **engine owns mode state** and switches the active mode
*before* the handler walk, emitting the command so the consumer updates its
(consumer-owned) selection. Dot-repeat replays by recorded **geometry**.

### Snapshot

Because chords are grammar productions, there is no separate keymap-layer state:
the snapshot is just the grammar's **`ParseState`** (which subsumes
`EngineSnapshot`'s count/operator *and* the chord-pending state). `peekProcessKey`
snapshots/restores one plain-data object.

## Before slice 1: implementation contracts

- **`step` core + `enumerate` for which-key** — above. eat-vs-yield is `step`'s
  match-or-not; literal capture is a wildcard terminal; `enumerate` is optional.
- **`Command` → dispatch** — `ActionArgs`/`HandlerFn` grow (slice-1 change), above.
- **Parked HP3 out of slice-1 types** — `StepResult` = `resolved | pending |
  cancelled | unmatched | composing`; matcher set excludes
  `subSession`/`externalOperand`; so slice-1 `ParseState` keeps today's
  clear-on-scope-change and carries no survives-scope-mount invariant.
- **Snapshot** — `ParseState` subsumes `EngineSnapshot`'s count/operator *and* the
  chord-pending state (chords are grammar productions); `peekProcessKey` snapshots
  one plain-data object. (§Modes.)
- **Mode-transition ownership** — engine owns mode state, flips before the handler
  walk, emits for the consumer.

## Staging

1. **Core (split for bisectability):**
   - **1a.** Recognizer (`step` + serializable `ParseState`) + `Command` output +
     `ActionArgs`/`HandlerFn` growth + **wrap** `EngineResult`. Port `count` +
     simple actions + the emacs universal-arg grammar.
   - **1b.** `operator` + `motion` + multiplied counts + doubling (preset-generated
     per-operator `key(opKey)→linewise` productions).
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
