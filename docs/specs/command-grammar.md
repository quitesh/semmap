# Command grammar

This document describes the **command grammar** in the semmap core: the
subsystem that turns a stream of keystrokes into a structured `Command`. It is
reference documentation for contributors working on the recognizer, the preset
layer, or the mode stack. It explains the model first (what the grammar *is*),
then the recognizer mechanism, then how presets and users author on top of it.

Related types: `KeyboardEngine`, `EngineResult`, `EngineState`,
`EngineSnapshot`, `ScopeStack`, `Dispatcher`, and the `presets/vim` /
`presets/emacs` grammars.

## The model

semmap routes a keystroke through four stages:

```
key → grammar (terminals key→semantic, then compose) → Command{semantic ids}
    → remap (semantic→concrete, per mode) → handler
```

The defining idea is that **the grammar is the keymap**. There is no separate
keymap layer and no context-flag "selectors": a terminal *is* a binding
(`key → semantic id`), and recognition *is* the keymap lookup. The only thing
downstream of recognition is dispatch — the existing per-mode `remap → handler`,
unchanged.

This means semantic rebinding survives at two independent points:

- **key → semantic** — the terminal rules (the rebindable layer).
- **semantic → concrete** — the per-mode remap (the consumer's layer).

A composite `Command` carries several semantic ids at once (e.g. operator +
motion); remap applies to each.

This structure is what makes a real vim grammar expressible at all — text
objects, `f<char>`, registers, multiplied counts, operator doubling, `g`/`z`
namespaces, search, and visual mode all compose out of terminals and
combinators rather than living as bespoke special cases.

### Core vs. preset

semmap is split into a **neutral core** and an **editor-specific preset layer**.

**Core** is the recognizer plus the **base combinators** — no editor concepts:

- `key(k)` / `group(name)` — match a specific key, or any terminal in semantic
  namespace `name` (e.g. `motion`).
- `literal(name)` — a **wildcard terminal**: match *any* next key and capture it
  as a named argument (`f`/`t`/`r`/`m`/register). This is not a "lexer demand";
  it is simply a terminal that matches anything.
- `count` — accumulate a leading number onto the command.
- `seq`, `choice`, `optional`, `repeat`, `ref` — composition.

Each terminal emits a semantic id; each matcher carries the effect it emits when
matched (syntax-directed). A matcher may set its dead-end policy via
`onDeadEnd: 'eat' | 'yield' | 'resolve'` (see [The recognizer](#the-recognizer)).

**Presets** are everything editor-specific, built *on top of* the core
combinators: the paradigm helpers `operatorPending()`, `prefixArg()`,
`selectionFirst()`, and the vim/emacs grammars. semmap ships these as a
convenience, but they impose nothing on the core. The core imposes **no command
ontology** — namespaces like `motion` or `operator` are a preset's vocabulary,
not the engine's.

### Terminals — `key → semantic id`

A terminal is exactly `key → semantic id` (`w → motion.word`,
`d → operator.delete`). There is no lexer, no token type, and no command "kind".
Keys are grouped by **semantic namespace**: the `motion` group is simply the set
of terminals whose id is `motion.*`, and the grammar composes by namespace.

Two consequences follow:

- **Polysemy is grammar position, not a flag.** `i` is `textobject` at the
  operand position and `action:insert` at command start — these are different
  productions in the grammar, not one key with a mode flag.
- **Rebinding is per grammar-position**, exactly mirroring vim's
  `nmap`/`omap`/`imap` split. Command-start terminals are `nmap`;
  operand-position terminals are `omap`; insert terminals are `imap`. "Rebind
  `j`" is therefore *not* global — the grammar owns what a key means after an
  operator. The **grammar structure (composition) is preset-owned**; the
  **terminals (key → semantic, per position) are the rebindable layer**. A bare
  rebind defaults to command start; the operand context is rebound separately.

## The recognizer

The recognizer's single entry point is `step`:

```
step(state, key) → StepResult
```

It matches the key against the terminals reachable at the current parse
position. The matched terminal emits its effect (accumulate / capture / advance
/ complete), and `step` returns exactly one outcome per key:

- **Resolved** — a complete command. Emit the `Command` and clear state.
- **Pending** — a valid partial parse. Keep state and update the modeline.
  (Operator-pending and counts do not time out; chord prefixes keep the 1 s
  cancel.)
- **Cancelled (eat)** — mid-parse, no terminal matched → eat the key
  (`preventDefault`). This is today's `chordCancelled`.
- **Unmatched (yield)** — at a fresh start, no production begins → yield to
  native input. This is today's `unmatched`.
- **Suspended** — external sub-session only (see
  [Known limitations](#known-limitations-and-future-work)).
- **composing** — IME composition.

### Eat vs. yield falls out of `step`

There is no separate "is this key bound?" query. A key that matches a terminal
advances. A key that matches nothing is a dead end, resolved by the **innermost
in-progress frame's policy** — one active path, one policy:

- `operatorPending` (normal/visual) → **eat**.
- `prefixArg` / insert → **yield** (type the key). Insert does have mid-parse
  states (`C-r`/`C-o`/`C-v`/`C-k`/`C-x`); yielding is its safety policy.
- `count` → **resolve**: complete the count consuming no key, then re-feed the
  key from a fresh start with the count applied. (So `count` needs no special
  interrupt handling.)

`onDeadEnd: 'resolve'` is valid only where completing yields a *safe* command.
It is **forbidden** where it would commit a destructive incomplete command — a
bare operator must never resolve to "delete nothing".

### Output-only registers

State registers — operator, count, register, captured literals, last-find — are
a **forward, output-only accumulator**. They are synthesized onto the `Command`
and are **never read to gate a match**. Matching is purely **structural**
(parse position + key); there are no state-gated matchers and no guards.

Vim's two seemingly-stateful rules need no state read:

- **Counts** are a greedy `repeat`.
- **Operator doubling** (`dd`) is a per-operator *structural* production that the
  `operatorPending` helper generates at grammar-build time. For each operator it
  emits `key(opKey) → linewise` at the operand position, so doubling follows
  rebinding automatically and the core never has a concept of "doubling".

### Recognizer class

The recognizer is a **deterministic pushdown recognizer, online, with zero
lookahead**:

- **Online / one key per step.** Each key triggers one step that decides and
  consumes it. There is no peek and no buffered lookahead key — operationally
  **no lookahead**. ("LL(1)" names the grammar class, but the "1" is an
  offline-parser artifact; here the key is the current input, decided on
  arrival.)
- **Deterministic.** `(configuration, key) → a unique transition`, or a dead
  end. No backtracking, no look-back.
- **Real-time.** O(grammar-depth) per key.
- **Pushdown.** The parse stack carries the shallow command nesting.

### Admissibility

A grammar is checked at compile time and can be **rejected**. The checks run over
the **key** terminals:

1. **FIRST/FIRST disjoint** at every choice — *except* that a greedy `repeat` may
   share first-keys with its follow-set, resolved **continue-over-exit**. (This
   is how `count`'s `[0-9]*` claims `0` over the `0`-motion.) This is the one
   sanctioned precedence; otherwise first-sets must be disjoint.
2. **FIRST/FOLLOW disjoint** for every nullable element (`count?`, `optional`).
3. **No left recursion and no nullable cycles.**

A rebind is just an edit to terminal rules, which re-runs this check. There is no
separate remappable-registry hazard.

### Compilation to a DPDA

The recognizer is **compiled, not tree-interpreted.** Grammar-build emits an
**LL(1) parse table** — the DPDA transition function, where states fold into
stack symbols and per-transition effects are the output-register writes. `step`
runs that table over an explicit, serializable stack that *is* `ParseState` (and
the engine snapshot).

**Admissibility is table construction.** A cell that would receive two
productions is exactly a FIRST/FIRST or FIRST/FOLLOW conflict — *except* the one
sanctioned greedy-repeat overlap (Admissibility rule 1), which the builder
*fills* by the continue-over-exit precedence rather than flagging. Because the
table is keyed on concrete keys, that precedence resolves into a single static
cell at construction time:

```
M[count-tail,  '0'] = continue
M[count-fresh, '0'] = exit-to-0-motion
```

This is fully deterministic with no runtime tie-break. Checking and compiling are
therefore one pass: a rebind edits terminals, recompiles (cheap — dozens of
productions), and re-checks.

This recognizer is hand-rolled because no off-the-shelf parser combines what it
needs: runtime-built dynamic grammars, one-key resumable stepping,
per-transition effects, and FIRST/FOLLOW checks. (Lezer / tree-sitter / ANTLR
are build-time codegen; nearley / PEG are non-deterministic; Chevrotain keeps
state in the call stack.)

### Modeline and which-key

- **Modeline.** The modeline is an in-order traversal of the parse stack with
  positional (pre-/post-child) fragments, so `"a2d3w` renders in source order.
- **which-key.** This is optional and derived: `enumerate(state)` returns the
  keys reachable at the current position, with labels. It is the only consumer
  that needs "what is valid next" without supplying a key, and it is off the hot
  path.

## The resolved `Command`

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

- **It captures resolved values, never keystrokes.** Dot-repeat of `d/foo`
  re-runs the *resolved* pattern non-interactively; no parse-time state leaks
  into the command.
- **It wraps, it does not replace.** `EngineResult` keeps its discriminant and
  gains an additive `command?: Command`.
- **Dispatch.** The primary id (operator; else action/motion) routes through
  `remap → handler` with the structured `Command` as args. `ActionArgs` and
  `HandlerFn` carry `{register?, operator?, motion?, textObject?, linewise?,
  count?}`.

### Dot-repeat vs. keystroke macros

semmap keeps these two replay mechanisms distinct, exactly as vim keeps `.` and
`@` distinct. Do not unify them.

**Dot-repeat (`​.`)** is **command-level re-dispatch.** The engine tracks the
last **recordable** `Command` (recordable is a flag on the registered command)
and exposes a **replay primitive** that re-dispatches the resolved `Command` —
not keystrokes. The consumer wires `.` to it. Because the engine cannot see
buffer text, the **consumer supplies the recorded insert text**, stored
alongside the command; visual ops record selection **geometry**. Re-running the
resolved command rather than keys is what makes `.` robust: it survives rebinding
and sidesteps the mode-change and insert-sink replay problems that keystroke
macros hit.

**Keystroke macros (`q`/`@`, and a vim mapping's key-sequence RHS)** are
**keystroke replay** — a different mechanism, described under
[Macros](#macros-keystroke-replay).

## Modes and the mode stack

semmap owns a **stack of modes**. A mode is `{ grammar, remap, handler-refs }`,
where the **grammar is the bindings** — its terminals are the key → semantic map.
This unifies the binding stack and the per-mode grammar into a single structure.
Every mode has a grammar; most app modes (pane, modal) are **trivial** (a flat
`key → action`, no composition), while rich ones (vim-normal) compose. The app
drives the stack (push history-search when it opens, pop on close, as `useScope`
does today) and supplies handlers; semmap owns the stack, precedence, and
grammar-switching. (Prior art: emacs minor modes, Cocoa's responder chain, Zed's
key contexts.)

- **Two push semantics.** A **base mode** is *replaced* (vim `normal` ↔ `insert`
  ↔ `visual`); **overlay modes** *push/pop* (history-search, modal, completion).
- **Resolution and fallthrough.** The top mode's grammar tries to begin; an
  `Unmatched` falls to the next mode (stack-order precedence; a bottom
  `Unmatched` yields to native input). Once a grammar *begins* (Pending), it owns
  the rest of the command — mid-parse dead-ends **eat, never fall through**. So a
  mode's dead-end policy gates lower-mode and app bindings: those are reachable at
  a fresh start, not mid-command. App bindings are just terminals in the app
  mode's grammar (`C-r → action.search`).
- **Precedence is explicit stack position.** Overrides are data
  (`null`/`Unbind`, source-tagged user > preset > default) layered over terminal
  rules; this subsumes `claimsInput` (truncate the stack below a mode).
- **Prefix chords are grammar productions** (`C-x C-f`, `gg`, `zz`), not a
  separate keymap mechanism. Their pending state lives in the parse stack, and
  their conflict-checking is admissibility (chord-shadow / fan-out are FIRST/FIRST
  violations). `g`/`z` namespaces are ordinary productions, so `3gg` works (the
  count wraps the `gg` motion).
- **Visual mode is the `selectionFirst` grammar.** `normal` and `visual` share
  terminal rules and differ only in composition (`operatorPending` vs
  `selectionFirst`), which makes vim multi-paradigm. Transitions are
  recognizer-driven: `v`/`V`/`C-v` resolve to a mode-change command. The
  consumer still owns the selection; the engine emits the command so the consumer
  can update it.
- **Snapshot.** The snapshot *is* the grammar's `ParseState` (chords are
  productions, so their pending state is already in it). `ParseState` subsumes
  `EngineSnapshot`'s count/operator, and `peekProcessKey` snapshots one plain-data
  object.

### Engine-owned mode: two invariants

The engine owns **mode state, transitions, and active-keymap selection only**;
the consumer still owns the **text sink** (insert printables yield `unmatched`
to the editor). Two invariants on engine-owned mode are load-bearing for
keystroke macros:

1. **Synchronous flip.** On a mode-change command the engine switches the active
   keymap **synchronously, before the handler walk** — with no consumer render
   round-trip. (Otherwise a trailing `foo` in `ciwfoo<Esc>` would resolve against
   a stale keymap.)
2. **No state-clobbering keymap-source change.** The flip does **not** go through
   the state-clearing keymap-source change that consumer-driven mode swaps
   trigger today (`onKeymapSourceChanged`).

Dot-repeat replays a visual op by its recorded geometry, independent of these
invariants.

## Configuration and authoring

"The grammar is the keymap" is an *internal* fact — users still configure a flat
keymap, written in **JS** (the native, richest form; a consumer may also surface
it as YAML or a UI). There are three authoring roles:

- **User** sets **terminals** (`key → semantic action`, per mode/position). For
  the vim preset this **mirrors vim's mapping commands** — `nnoremap`,
  `onoremap`, `inoremap`, `vnoremap` — and vim key notation. The grammar
  *structure* is not user-editable.
- **Preset author (dev)** defines the **grammar**: composition per mode (the
  paradigm helpers) plus default mappings and semantic namespaces.
- **App (consumer)** supplies **remaps** (semantic → concrete) and **handlers**.

The vim-mode mapping namespaces *are* the per-position terminal layers: `nmap` =
command start, `omap` = operand (what a key means after an operator), `imap` =
insert, `vmap` = visual. So "rebind a key" is one mapping line, never a grammar
edit.

### Example — user config (JS, mirrors vim)

```js
import { vim } from '@quitesh/semmap/presets/vim'

export default vim.config((m) => {
  m.nnoremap('<C-r>', 'action.history-search')
  m.onoremap('p', 'textobject.paragraph')    // `dp` deletes a paragraph
  m.inoremap('<C-w>', 'input.kill-word-back')
  m.nnoremap('<leader>w', 'window.save')
})
```

### Example — preset definition (TS)

```ts
import { createPreset, operatorPending, selectionFirst, lineInput, group } from '@quitesh/semmap'

export const vim = createPreset({
  modes: {
    // composition: <operator> <count? target>; doubling auto-generated per operator
    normal: operatorPending({ operators: group('operator'),
                              target: group('motion', 'textobject', 'literalMotion') }),
    visual: selectionFirst({ /* operator applies to the current selection */ }),
    insert: lineInput(),
  },
  // default mappings — the same API the user overrides with
  defaults: (m) => {
    m.nnoremap('d', 'operator.delete'); m.nnoremap('w', 'motion.word')
    m.onoremap('iw', 'textobject.inner-word')
    m.nnoremap('f', 'literalMotion.find')      // `f` then a literal char
  },
})
```

The preset names only **semantic ids**; the app remaps them to concrete handlers
(`operator.delete → editor.deleteRange`,
`action.history-search → shell.historySearch`).

## Sub-sessions

A sub-session is how the grammar obtains an operand that is not a single
reachable key. There are two mechanisms, distinguished by *who produces the next
operand*.

- **Literal capture** (`f`/`t`/`r`/`m`/`"`) — the engine reads the next key
  itself, via a `literal` wildcard terminal. This is in-grammar and statically
  analyzable.
- **External sub-session** — an operand produced by a surface the engine cannot
  model (a fuzzy picker, async completion, or `d/foo` search). See
  [Known limitations](#known-limitations-and-future-work); the design here is not
  yet settled.

## Macros (keystroke replay)

Keystroke macros — recorded `q`/`@`, and a vim mapping's **key-sequence RHS**
(`nnoremap x dd`: press `x`, replay the keys `d`,`d`) — are **keystroke replay**,
distinct from dot-repeat's command re-dispatch.

- **The abstraction is preset/consumer-owned, not core.** The macro table,
  register store, recording state machine, `<expr>` evaluation, recursive
  expansion with a depth cap, and the replay loop are all consumer-owned. Record
  at the trusted-event layer (above the engine); replay by calling the engine
  directly — never by re-dispatching DOM events, which would re-enter the capture
  handler and double-record.
- **Count and operator thread for free.** The engine carries
  `countAccum`/`operatorPending` across steps, so feeding `2`,`d`,`d` resolves to
  delete-2-lines with no special replay primitive.
- **Gated on engine-owned mode.** A mode-changing macro (`ciwfoo<Esc>`) cannot be
  replayed correctly while mode is consumer-owned: the flip needs a render
  round-trip (the trailing `foo` would resolve against the stale keymap) and
  travels through the state-clearing keymap-source change. The synchronous,
  non-clobbering flip (see [Modes](#engine-owned-mode-two-invariants)) is the
  prerequisite.
- **Replay reproduces the full pipeline.** Insert printables yield `unmatched`
  and flow to the editor, so replay drives **both sinks** (engine + editor)
  exactly as live input does — it is not "call `processKey` N times".
- **The only new core surface is a read-only parse accessor.** To scope *when* a
  macro fires (don't expand a command-start macro mid-operator-pending — a blind
  `x`→`d`,`d` after `d` yields `ddd`) and to let `<expr>` read a live count, the
  engine exposes its **`ParseState` read-only** (phase + pending count).
  `countAccum` is otherwise private, and `pendingDisplay` alone cannot
  distinguish count-pending from operator-pending.

## Known limitations and future work

**External sub-session held-frame lifetime.** Literal capture is fully
in-grammar, but an external sub-session — a surface the engine cannot model
(fuzzy picker, async completion, `d/foo` search) — is an open design question. A
`subSession(kind)` matcher would emit a `Suspended` outcome carrying a
resume/cancel continuation over plain parse-stack data, with the host owning the
surface; live highlighting would read engine state (which needs a new
`EngineState.subInput` field and a change to `notify()`'s `pendingDisplay`-only
dedupe).

The unresolved problem is the **held-frame lifetime**: the engine must hold the
parse alive while the host mounts its scope (today `onKeymapSourceChanged` clears
state), and it must distinguish the awaited session-mount from an unrelated scope
change. Every surveyed engine (VSCodeVim, CodeMirror, IdeaVim, Zed,
vim-mode-plus) simply keeps the parse alive across the sub-session; semmap has
not yet committed to a mechanism, so `Suspended` and `subSession` are not part of
the current `StepResult` type surface.
