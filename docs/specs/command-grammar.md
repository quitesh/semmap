# Spec: Command grammar

Status: proposed — design resolved; the `d/foo` sub-session held-frame lifetime is
parked (deferrable slice). Ready for slice 1a.
Owner: —
Related: `KeyboardEngine`, `EngineResult`, `EngineState`, `EngineSnapshot`,
`ScopeStack`, `Dispatcher`, presets/vim, presets/emacs.

## Summary

Put an incremental **command grammar** in the core engine: it turns a stream of
keystrokes into a structured `Command`. The grammar is **the keymap** — its
terminals map `key → semantic id` — plus composition. The **core is neutral**: a
deterministic structural recognizer + base combinators. Everything editor-specific
— operators, motions, text objects, doubling, vim/emacs semantics — lives in
**presets** built from those combinators. This is what makes real vim grammar
(text objects, `f<char>`, registers, multiplied counts, operator doubling, `g`/`z`
namespaces, search, visual) expressible at all.

## Goal

**Make building an evil-mode-class modal input scheme easy** — a declarative
grammar *definition* over a shared in-core recognizer, not a hand-rolled parser.
evil-mode is thousands of lines of bespoke recognizer in Lisp *because* emacs's
core offers no grammar; this eliminates that. The recognizer belongs in the core
(resolving stateful multi-key input is the engine's job and its value); the
*semantics* stay swappable in presets — never hardcode an editor's command types
into the engine. Static analysis (conflicts, which-key) and dot-repeat come free
from a declarative grammar.

## Model

```
key → grammar (terminals key→semantic, then compose) → Command{semantic ids}
    → remap (semantic→concrete, per mode) → handler
```

The grammar **is the keymap**: there is no separate keymap layer and no
context-flag "selectors". Recognition is the grammar; the only thing downstream is
dispatch — the existing per-mode `remap → handler`, unchanged. So semantic
rebinding survives at both points: **key→semantic** (terminal rules) and
**semantic→concrete** (remap). A composite `Command` carries several semantic ids
(operator + motion); remap applies to each.

### Core vs. preset

- **semmap core** = the recognizer + **base combinators**, neutral, no editor
  concepts:
  - `key(k)` / `group(name)` — match a specific key / any terminal in semantic
    namespace `name` (e.g. `motion`).
  - `literal(name)` — a **wildcard terminal**: match *any* next key, capture it as
    a named argument (`f`/`t`/`r`/`m`/register). No "lexer demand"; just a terminal
    that matches anything.
  - `count` — accumulate a leading number onto the command.
  - `seq`, `choice`, `optional`, `repeat`, `ref`.
  Each terminal emits a semantic id; each matcher carries the effect it emits when
  matched (syntax-directed). A matcher may set `onDeadEnd: 'eat'|'yield'|'resolve'`.
- **Preset/helper layer** = everything editor-specific, built from those
  combinators: the paradigm helpers `operatorPending()`, `prefixArg()`,
  `selectionFirst()`, and the vim/emacs presets. semmap may ship them as a
  convenience, but they are a layer *on top of* the neutral core.

### Terminals — `key → semantic id`

A terminal is `key → semantic id` (`w → motion.word`, `d → operator.delete`). No
lexer, no token-type, no command "kind". Keys group by **semantic namespace**: the
`motion` group is the terminals whose id is `motion.*`; the grammar composes by
namespace.

- semmap imposes **no command ontology** — namespaces are a preset's vocabulary.
- **Polysemy is grammar position**: `i` is `textobject` at the operand position and
  `action:insert` at command-start — different productions, no flag.
- **Rebinding is per grammar-position** — exactly vim's `nmap`/`omap` split.
  Command-start terminals are `nmap`; operand-position terminals are `omap`; insert
  is `imap`. "Rebind `j`" is therefore not global, *because the grammar owns what a
  key means after an operator*. The **grammar structure (composition) is
  preset-owned**; the **terminals (key→semantic, per position) are the rebindable
  layer**. A bare rebind defaults to command-start; the operand context is rebound
  separately.

### The recognizer: `step`

`step(state, key) → StepResult`. It matches the key against the terminals
reachable at the current parse position; the **matched terminal emits its effect**
(accumulate / capture / advance / complete). One outcome per key:

- **Resolved** — complete command; emit the `Command`, clear state.
- **Pending** — valid partial parse; keep state, update modeline. (Operator-pending
  and counts don't time out; chord prefixes keep the 1 s cancel.)
- **Cancelled (eat)** — mid-parse, no terminal matched → eat (`preventDefault`);
  today's `chordCancelled`.
- **Unmatched (yield)** — fresh start, no production begins → yield to native input;
  today's `unmatched`.
- **Suspended** — external sub-session only (parked; §Sub-sessions). Not slice 1.
- **composing** — IME.

**Eat-vs-yield falls out of `step`** (no separate query): a key that matches a
terminal advances; a key that matches nothing is a dead end resolved by the
**innermost in-progress frame's policy** (one active path, one policy):

- `operatorPending` (normal/visual) → **eat**.
- `prefixArg` / insert → **yield** (type the key). Insert *does* have mid-parse
  states (`C-r`/`C-o`/`C-v`/`C-k`/`C-x`); safety is its yield policy.
- `count` → **resolve**: complete the count consuming no key, then re-feed the key
  from a fresh start with the count applied. (So count needs no special interrupt.)

`onDeadEnd: 'resolve'` is valid only where completing yields a safe command;
**forbidden** where it would commit a destructive incomplete command (a bare
operator must never resolve to "delete nothing").

**Modeline** = an in-order traversal of the parse stack with positional
(pre-/post-child) fragments, so `"a2d3w` renders in source order.

**which-key** is optional and derived — `enumerate(state)` → the keys reachable at
the current position with labels. The *only* consumer needing "what's valid next"
without a key; not in the hot path.

### Recognizer class (formal)

A **deterministic pushdown recognizer, online, with zero lookahead**:

- **online / one key per step** — each key triggers one step that decides and
  consumes it. No peek, no buffered key ahead — operationally **no lookahead**.
  ("LL(1)" is the grammar-class name, but the "1" is an offline-parser artifact;
  here the key is the current input, decided on arrival.)
- **deterministic** — `(configuration, key) → a unique transition`, or a dead end.
  No backtracking, no look-back.
- **real-time** — O(grammar-depth) per key.
- **pushdown** — the parse stack carries the shallow command nesting.

State registers (operator, count, register, captured literals, last-find) are a
**forward, output-only accumulator** — synthesized onto the `Command`, **never
read to gate a match**. Matching is purely **structural** (position + key); no
state-gated matchers, no guards. Vim's two seemingly-stateful rules need no state
read: counts via greedy `repeat`; operator doubling via per-operator structural
productions the `operatorPending` helper generates at grammar-build time (for each
operator it emits `key(opKey) → linewise` at the operand position, so doubling
follows rebinding — the core never sees "doubling").

**Admissibility — compile-time, rejectable.** Over the **key** terminals:

1. **FIRST/FIRST disjoint** at every choice — *except* a greedy `repeat` may share
   first-keys with its follow-set, resolved **continue-over-exit** (how `count`'s
   `[0-9]*` claims `0` over the `0`-motion). The one defined precedence; else
   disjoint.
2. **FIRST/FOLLOW disjoint** for every nullable element (`count?`, `optional`).
3. No left recursion, no nullable cycles.

A rebind is just editing terminal rules → re-runs this check. No remappable-registry
hazard.

### Resolved command

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

- **Captures resolved values, never keystrokes** — dot-repeat of `d/foo` re-runs
  the resolved pattern non-interactively; no parse-time state leaks in.
- **Wrap, not replace.** `EngineResult` keeps its discriminant + an additive
  `command?: Command`.
- **Dispatch (slice-1 change).** Route the primary id (operator; else
  action/motion) through `remap → handler`, with the structured `Command` as args;
  `ActionArgs`/`HandlerFn` grow to carry `{register?, operator?, motion?,
  textObject?, linewise?, count?}`.
- **Dot-repeat / macros.** The engine tracks the last **recordable** `Command`
  (recordable = a flag on the registered command) and a **replay primitive**
  (re-dispatch); the consumer wires `.`. The engine can't see buffer text, so the
  **consumer supplies the recorded insert text**, stored alongside. Visual ops
  record selection **geometry**.

## Configuration

"The grammar is the keymap" is an *internal* statement — users still configure a
flat keymap. Three roles, three artifacts:

- **User** edits a **keymap**: flat `key → semantic action`, per mode/position.
  This *is* the grammar's terminal rules and is the only thing most users touch
  (≈ today's YAML). The grammar *structure* (composition) is not user-editable.
- **Preset author (dev)** defines the **grammar**: the composition (via paradigm
  helpers) + default terminals + semantic namespaces. Ships as a preset.
- **App (consumer)** supplies **remaps** (semantic → concrete) and **handlers**
  (concrete → fn) per mode, exactly as today.

The user keymap overrides/extends the preset's terminals; the preset owns
composition; the app owns dispatch. So "rebind a key" is a one-line keymap edit,
never a grammar edit.

### Example — user keymap (config file)

```yaml
keys:
  normal:                           # command-start (vim nmap)
    d: operator.delete
    w: motion.word
    j: action.down
    ctrl+r: action.history-search
    ctrl+x > ctrl+f: action.palette   # multi-key → a prefix production
  insert:                           # vim imap
    ctrl+w: input.kill-word-back
  normal.operand:                   # operand position (vim omap) — advanced, optional
    p: textobject.paragraph         # makes `dp` delete a paragraph
```

`ctrl+r` is just a terminal in normal-mode's grammar; `d` is the `operator.delete`
terminal the preset's `operatorPending` composes. Most users only ever edit the
command-start section.

### Example — dev preset (TypeScript)

```ts
import { mode, operatorPending, group } from '@quitesh/semmap'

export const vimNormal = mode({
  // composition: <operator> <count? target>; doubling auto-generated per operator
  grammar: operatorPending({
    operators: group('operator'),                 // terminals whose id is operator.*
    target:    group('motion', 'textobject', 'literalMotion'),
  }),
  // default terminals (key → semantic id) — the user keymap overrides these
  terminals: {
    d: 'operator.delete', c: 'operator.change', y: 'operator.yank',
    w: 'motion.word',     b: 'motion.back',     $: 'motion.eol',
    i: 'textobject.inner', a: 'textobject.around',     // then an object-id key
    f: 'literalMotion.find',                           // then a literal char
  },
})
```

The preset names only **semantic ids**, never app behaviour. The app's mode then
remaps `operator.delete → editor.deleteRange`,
`action.history-search → shell.historySearch`, and its handlers do the work.

## Modes — the mode stack

semmap owns a **stack of modes**. A mode is `{ grammar, remap, handler-refs }` —
the **grammar is the bindings** (its terminals are the key→semantic map). This
unifies the binding stack and the per-mode grammar into one. Every mode has a
grammar; most app modes (pane, modal) are **trivial** (flat `key → action`, no
composition); rich ones (vim-normal) compose. The app drives the stack (push
history-search when it opens, pop on close — as `useScope` does today) and supplies
handlers; semmap owns the stack, precedence, and grammar-switching. *(Prior art:
emacs minor modes, Cocoa's responder chain, Zed's key contexts.)*

- **Two push semantics:** a **base mode** is *replaced* (vim `normal` ↔ `insert` ↔
  `visual`); **overlay modes** *push/pop* (history-search, modal, completion).
- **Resolution & fallthrough.** The top mode's grammar tries to begin; `Unmatched`
  falls to the next mode (stack-order precedence; bottom `Unmatched` yields to
  native). Once a grammar *begins* (Pending) it owns the rest of the command —
  mid-parse dead-ends **eat, never fall through**. So a mode's dead-end policy
  gates lower-mode/app bindings: reachable at a fresh start, not mid-command. App
  bindings are just terminals in the app mode's grammar (`C-r → action.search`).
- **Precedence is explicit stack position**; **override-as-data** (`null`/`Unbind`,
  source-tagging user > preset > default) layers terminal rules; subsumes
  `claimsInput` (truncate the stack below a mode).
- **Prefix chords are grammar productions** (`C-x C-f`, `gg`, `zz`), not a keymap
  mechanism — their pending state is in the parse stack, their conflict-checking is
  admissibility (chord-shadow / fan-out = FIRST/FIRST violations). `g`/`z`
  namespaces are ordinary productions (`3gg` works: count wraps the `gg` motion).
- **Visual = the `selectionFirst` grammar.** `normal`/`visual` share terminal rules
  and differ only in composition (`operatorPending` vs `selectionFirst`). vim is
  thus multi-paradigm. Transitions are recognizer-driven: `v`/`V`/`C-v` resolve to
  a mode-change command; the engine owns mode state and switches the active mode
  *before* the handler walk, emitting the command so the consumer updates its
  (consumer-owned) selection. Dot-repeat replays by recorded geometry.
- **Snapshot** is just the grammar's `ParseState` (chords are productions, so their
  pending state is in it). `ParseState` subsumes `EngineSnapshot`'s count/operator;
  `peekProcessKey` snapshots one plain-data object.

## Sub-sessions

Two mechanisms, by who produces the next operand:

- **Literal capture** (`f`/`t`/`r`/`m`/`"`) — the engine reads the next key itself
  (a `literal` wildcard terminal). In-grammar, statically analyzable. Slice 1.
- **External sub-session** (parked) — a surface the engine can't model (fuzzy
  picker, async completion, `d/foo` search). A `subSession(kind)` matcher emits a
  `Suspended` outcome with a resume/cancel continuation over plain parse-stack
  data; the host owns the surface (live highlighting reads engine state — note this
  needs a new `EngineState.subInput` field + a change to `notify()`'s
  `pendingDisplay`-only dedupe, not free). **Open problem:** the held-frame
  lifetime — the engine must hold the parse across the host mounting its scope
  (today `onKeymapSourceChanged` clears state) and distinguish the awaited
  session-mount from an unrelated scope change. Every surveyed engine (VSCodeVim,
  CodeMirror, IdeaVim, Zed, vim-mode-plus) just keeps the parse alive across the
  sub-session. **`Suspended`/`subSession` are out of the slice-1 type surface.**

## Staging

1. **Core, split for bisectability:**
   - **1a.** Recognizer (`step` + serializable `ParseState`) + `Command` output +
     `ActionArgs`/`HandlerFn` growth + wrap `EngineResult`. Port `count` + simple
     actions + the emacs universal-arg grammar.
   - **1b.** `operator` + `motion` + multiplied counts + doubling (preset-generated
     per-operator `key(opKey)→linewise`).
   - **1c.** Text objects (`choice` over groups) + literal capture (`f`/`t`).
   Move vim/emacs grammar out of the core into presets across 1a–1c.
2. **Namespaces & arguments** — `g`/`z` prefixes, registers `"`, marks.
3. **Search / `d/foo` (parked)** — settle the held-frame lifetime before building.
4. **Visual mode.**
5. **Repeat / macros** on the structured `Command` (+ `enumerate`/which-key any
   time after 1a).

## Slice-1 contracts

- **`Command` → dispatch** — `ActionArgs`/`HandlerFn` grow (slice 1, since 1c ships
  text objects + `f`/`t`).
- **Parked sub-sessions out of slice-1 types** — `StepResult` = `resolved | pending
  | cancelled | unmatched | composing`; no `subSession`/`Suspended`; so slice-1
  `ParseState` keeps today's clear-on-scope-change and carries no
  survives-scope-mount invariant.
- **Snapshot** — `ParseState` subsumes `EngineSnapshot`'s count/operator (and chord
  state, since chords are productions); `peekProcessKey` snapshots one object.
- **Mode-transition ownership** — engine owns mode state, flips before the handler
  walk, emits for the consumer.

## Open

- **Sub-session held-frame lifetime** (parked) — the one remaining hard problem;
  see §Sub-sessions.
