# `@quite/semmap` — Design

**Status:** approved, pending implementation.
**Author:** sauyon
**Date:** 2026-05-28

This is a short record of decisions already made off-doc. It exists so future
contributors don't relitigate the framing. Implementation plan lives at
`docs/superpowers/plans/2026-05-28-semmap-extraction-plan.md`.

## Goal

Extract the keystroke-routing engine and scope stack currently embedded in
`quite-app` into a standalone, pure-TypeScript library published as
`@quite/semmap` so both `quite-app` and the planned `zen-keys` (a
keyboard-driven Firefox/Zen fork) can consume one implementation instead of
forking copies.

## Audience

`@quite/semmap` consumers are downstream JS apps that want layered, scope-aware
keystroke routing with vim/emacs grammar built in. The library is not a UI
framework — it's a routing core. React glue, focus management, action
catalogs, YAML config, and per-app dispatch policy all stay in the consumer.

## Name

SEMantic MAPping engine. Anchor on "sem", captures both semantic and
key mapping/routing, library-shaped, clean phonetics, no opposite-vibe dev
priors. npm scope: `@quite`.

## Architecture overview

Three layers, walked top-of-stack first:

1. **Keymap** — keystroke → semantic action id (`j` → `action.down`).
2. **Per-scope remap** — semantic id → concrete handler id (`action.down` →
   `list.next` in a list scope; `cursor.down` in an editor scope).
3. **Per-scope handler** — concrete id → consumer-registered function.

Plus: vim grammar (operators + motions + counts), emacs-style universal
argument (`C-u`), multi-key chord prefixes (`C-x C-c`), chord cancellation,
prefix timeouts, static conflict detection (chord-shadow, fan-out), and
snapshot/restore (`peekProcessKey`) for parity tests.

### Extracted files

From `quite-app/quitesh/src/` into `@quite/semmap/src/`:

- `keyboardEngine.ts` — grammar state machine
- `modeRegistry.ts` — `KeyEvent`, `normalizeKeyEvent`, layout-aware base-key resolution (the `Mode`/`ModeId` types are vestigial after the KeymapSource refactor; carry along for API parity, prune later)
- `keyboard/keymap.ts` — `BindingEntry`, `Keymap`, semantic vs concrete action id types, `defineSemanticActionRemaps`
- `keyboard/scopeStack.ts` — `ScopeStack` class
- `keyboard/dispatcher.ts` — `Dispatcher` class (slimmed; see API changes)
- `keyboard/engineKeyEvent.ts` — `setEngineKeyResult` / `getEngineKeyResult`
- `layoutMap.ts` — keyboard layout resolution table

Into `@quite/semmap/src/presets/`:

- `presets/vim.ts` → exported as `vimGrammar`
- `presets/emacs.ts` → exported as `emacsGrammar`

Tests that go with them (port to `@quite/semmap`):

- `keyboard/__tests__/scopeStack.test.ts`
- `keyboard/__tests__/dispatcher.test.ts`
- `__tests__/keyboardEngine.test.ts` (most of it — see plan for the slice)
- `__tests__/layoutMap.test.ts`
- `__tests__/vimPreset.test.ts`

(`keyboard/__tests__/buildInputScopeKeymap.test.ts` stays in the consumer
— the helper it tests is consumer code, and the test file's assertions are
all about the helper, not the engine.)

### What stays in quite-app (NOT extracted)

- React glue: `KeyboardProvider.tsx`, `useScope.ts`, `useSemanticKeymap.ts`, `useKeyboardConflicts.ts`, all `*KeyboardScope.tsx` files
- Quite-app's action catalog and YAML config: `keybindings.ts`, `buildKeybindingPreset.ts`, `resolveBindingsForEngineMode.ts`
- `keyboard/buildInputScopeKeymap.ts` (depends on quite-app's `passToInput` semantics — see API change #1; the consumer reimplements this against the new `passthrough` type)
- `keyboard/dispatchPassTarget.ts` — collapses into App.tsx capture handler (see API change #1)
- `keyboard/shellEnginePostKey.ts`, `keyboard/textInputActions.ts`, `keyboard/editOps.ts` — quite-app-specific action implementations
- `keyboard/focusContext.ts`, `keyboard/useModalFocusNav.ts` — DOM/React helpers
- Plugin scope system, terminal re-dispatch logic

## API changes during extraction

These are settled decisions, not open questions.

### 1. Unify pass-through types

Today the engine has both `passToInput` and `passToTerminal` as
`BindingEntry`/`EngineResult` variants, and `Dispatcher` has a `passTargets:
Map<string, handler>` for named pass-targets. Replace both variants with a
single `{ type: 'passthrough' }` in both unions. Drop `passTargets` and
`registerPassTarget` from `Dispatcher` entirely.

**Rationale.** The consumer always knows what to do with a yielded keystroke
based on the current focus / active scope. Encoding "terminal vs input" in the
engine leaks app-specific routing into a generic library, and the
`passToInput` path already exists only to *not* be dispatched (App.tsx
short-circuits before reaching the dispatcher so the trusted keydown reaches
CodeMirror naturally). Collapsing to `passthrough` makes the contract honest:
the engine says "this key isn't mine"; the consumer decides what to do.

`quite-app` absorbs the cost: the terminal re-dispatch logic moves out of the
library into `App.tsx`'s capture handler as a `result.type === 'passthrough'`
branch that checks the active focus context (uses the existing
`data-focus-context="terminal-interactive"` lookup, not a TerminalView class
reference).

### 2. Preset action constants, overridable

`keyboardEngine.ts` currently hardcodes the operator → action mapping:

```ts
const OPERATOR_TO_ACTION = { d: 'vim.delete', c: 'vim.change', y: 'vim.yank' }
```

Promote to constructor options with exported defaults. The exported `Actions`
constants ARE the default action id strings, so a consumer using
`Actions.OPERATOR_DELETE` gets the exact value the default mapping emits.

```ts
export const Actions = {
  OPERATOR_DELETE: 'vim.delete',
  OPERATOR_CHANGE: 'vim.change',
  OPERATOR_YANK:   'vim.yank',
  UNIVERSAL_ARG:   'action.universalArgument',
} as const

new KeyboardEngine(source, {
  operatorActions: {              // default: { d: Actions.OPERATOR_DELETE, c: ..., y: ... }
    d: 'app.delete',
    c: 'app.change',
    y: 'app.yank',
  },
  universalArgAction: 'app.universalArg',  // default: Actions.UNIVERSAL_ARG
})
```

The default literals preserve quite-app's existing action ids (`vim.delete`,
`action.universalArgument`) so its tests pass without renaming. The "vim"
prefix in the operator defaults is a historical accident; consumers in a
non-vim context (e.g. zen-keys browser) reference the `Actions.*` constants
when registering remaps, not the bare strings, so the naming doesn't leak.

### 3. Ship preset grammar fragments

`presets/vim.ts` and `presets/emacs.ts` move into `@quite/semmap` under
separate subpath exports: `@quite/semmap/presets/vim` exports `vimGrammar`,
`@quite/semmap/presets/emacs` exports `emacsGrammar`. No combined
`@quite/semmap/presets` barrel — consumers import only the preset they use,
which keeps tree-shaking honest from day one and avoids a meta-export that
just re-exports two unrelated grammars. Quite-app's `buildKeybindingPreset.ts`
stays in quite-app since it weaves in YAML config and shell-chord overrides
that are quite-app-specific.

## Integration surface consumers see

### Imports

```ts
import {
  KeyboardEngine,
  ScopeStack,
  Dispatcher,
  normalizeKeyEvent,
  resolveBaseKey,
  setEngineKeyResult,
  getEngineKeyResult,
  defineSemanticActionRemaps,
  isSemanticActionId,
  Actions,
  // layout-map surface (in-memory; see "Layout map" section below)
  observeKey,
  resolveCode,
  getLayoutMap,
  setLayoutMap,
  subscribeLayoutMap,
  addLayoutSource,
  QWERTY_MAP,
} from '@quite/semmap'

import type {
  KeyEvent,
  EngineResult,
  BindingEntry,
  Keymap,
  KeyStr,
  ActionId,
  KeymapActionId,
  HandlerActionId,
  SemanticActionId,
  SemanticActionRemaps,
  ActionRemap,
  ActionArgs,
  HandlerFn,
  Scope,
  KeymapSource,
  EngineState,
  KeymapConflict,
  LayoutMap,
  LayoutSource,
  // Vestigial parity surface; see "Open follow-ups"
  Mode,
  ModeId,
} from '@quite/semmap'

import { vimGrammar } from '@quite/semmap/presets/vim'
import { emacsGrammar } from '@quite/semmap/presets/emacs'
```

### Discriminated unions

```ts
type EngineResult =
  | { type: 'action'; action: string; count?: number; motion?: string }
  | { type: 'passthrough' }
  | { type: 'pending'; pendingDisplay: string }
  | { type: 'unmatched' }
  | { type: 'composing' }
  | { type: 'chordCancelled'; cancelledDisplay: string }

type BindingEntry =
  | { type: 'action'; action: string }
  | { type: 'operator'; operator: string }
  | { type: 'motion'; motion: string }
  | { type: 'prefix'; keymap: Keymap }
  | { type: 'passthrough' }
```

### `KeyboardEngine`

```ts
class KeyboardEngine {
  constructor(
    source: KeymapSource,
    options?: {
      conflicts?: readonly KeymapConflict[]
      prefixTimeoutMs?: number    // default 1000
      operatorActions?: Record<string, string>  // default { d: Actions.OPERATOR_DELETE, c: ..., y: ... }
      universalArgAction?: string  // default Actions.UNIVERSAL_ARG
    }
  )

  processKey(e: KeyEvent): EngineResult
  peekProcessKey(e: KeyEvent): EngineResult   // snapshot/restore; for parity tests, no state mutation, no notify
  getState(): EngineState
  peekState(): EngineState                    // same as getState; pinned for backwards compat
  subscribe(cb: () => void): () => void       // observer for status-line / which-key
  getConflicts(): readonly KeymapConflict[]
  reset(): void
  onKeymapSourceChanged(): void               // call when the external scope stack swap; clears grammar overlay
  dispose(): void                             // clears pending chord timer
}

interface EngineState {
  pendingDisplay: string  // for status line: "3d", "C-x ", etc.
}
```

### `ScopeStack`

`ScopeStack` implements `KeymapSource` — it's the canonical source the `KeyboardEngine` reads from. Public methods:

```ts
class ScopeStack implements KeymapSource {
  pushOrUpdate(scope: Scope): void   // identity by scope.id; replaces if present, else pushes to top
  pop(id: string): void
  snapshotIds(): string[]             // bottom→top, for diagnostics

  // KeymapSource interface (the engine calls these)
  iterateKeymaps(): Iterable<Keymap>   // top-down walk, respecting claimsInput floor
  acceptsLeadingCount(): boolean        // true when topmost active scope sets acceptsLeadingCount

  // Dispatch helpers (consumer calls these after engine emits an 'action' result)
  walkRemap(action: KeymapActionId): HandlerActionId   // recursive semantic→concrete resolution
  walkHandler(action: HandlerActionId, args?: ActionArgs): boolean   // returns true if claimed
  dispatchAction(action: HandlerActionId, args?: ActionArgs): boolean  // walkRemap + walkHandler ignoring claimsInput

  subscribe(cb: () => void): () => void
}

interface Scope {
  id: string
  keymap?: Keymap                       // key → BindingEntry; main scope binds
  semanticKeymap?: Keymap                // visible through a `claimsInput` floor for global semantic actions
  remaps?: ActionRemap                   // semantic → concrete per-scope
  handlers?: ReadonlyMap<HandlerActionId, HandlerFn>
  claimsInput?: boolean                  // true = scopes below are hidden (except their semanticKeymap)
  acceptsLeadingCount?: boolean          // true = digit keys accumulate as count (vim normal/visual)
}

interface ActionArgs {
  count?: number
  motion?: string
}

type HandlerFn = (action: HandlerActionId, args: ActionArgs) => boolean
type ActionRemap = ReadonlyMap<ActionId, HandlerActionId>
```

### `Dispatcher`

Thin convenience wrapper around `ScopeStack`. After the `passToInput` / `passToTerminal` collapse (API change #1), `Dispatcher` exposes one method:

```ts
class Dispatcher {
  constructor(stack: ScopeStack)
  dispatch(result: EngineResult, e: KeyEvent): boolean  // walks remap+handler for 'action'; returns false otherwise
}
```

Consumers may bypass `Dispatcher` and call `ScopeStack.walkRemap`/`walkHandler` directly — both are public. Use `Dispatcher` if you want one-liner dispatch; call `ScopeStack` methods directly if your dispatch flow needs to inspect the result first (this is what `zen-keys` does).

### `KeymapSource`

```ts
interface KeymapSource {
  iterateKeymaps(): Iterable<Keymap>   // top-down; engine walks until first hit
  acceptsLeadingCount(): boolean
}
```

(`Keymap` is `Map<KeyStr, BindingEntry>`; the longer form `Iterable<Map<string, BindingEntry>>` is interchangeable.)

`ScopeStack` is the canonical implementation. Consumers may implement their own `KeymapSource` for tests or for non-scope-based dispatch.

### `Actions` constants

```ts
const Actions = {
  OPERATOR_DELETE: 'vim.delete',
  OPERATOR_CHANGE: 'vim.change',
  OPERATOR_YANK:   'vim.yank',
  UNIVERSAL_ARG:   'action.universalArgument',
} as const
```

These ARE the default literal action id strings. Defaults map `{d → Actions.OPERATOR_DELETE, c → Actions.OPERATOR_CHANGE, y → Actions.OPERATOR_YANK}` for operators, and emit `Actions.UNIVERSAL_ARG` for `C-u`. Consumers override via the `operatorActions` and `universalArgAction` constructor options to use their own ids.

### `vimGrammar` / `emacsGrammar`

```ts
// @quite/semmap/presets/vim
function vimGrammar(): { normal: Keymap; insert: Keymap; opPending: Keymap }

// @quite/semmap/presets/emacs
function emacsGrammar(): Keymap
```

Each returns bare grammar fragments — keymaps that bind the vim operators/motions/counts or emacs chord prefixes and universal-argument key. Consumers compose these into their own scope keymaps (overlay their app-specific binds on top, or layer on top of the consumer's own preset). The presets ship as separate subpath exports (no combined `presets` barrel) so a consumer that only uses one preset pays no cost for the other.

### `setEngineKeyResult` / `getEngineKeyResult`

```ts
function setEngineKeyResult(e: KeyEvent | KeyboardEvent, result: EngineResult): void
function getEngineKeyResult(e: KeyEvent | KeyboardEvent): EngineResult | undefined
```

Caches the engine result on the event itself (via a private symbol property) so downstream handlers can read the verdict without re-running `processKey`. Saves CPU and prevents state drift if multiple capture handlers fire on the same event.

### Layout map (in-memory; consumer owns persistence)

```ts
function observeKey(code: string, key: string): void
function resolveCode(code: string): string | undefined
function getLayoutMap(): Readonly<LayoutMap>
function setLayoutMap(map: LayoutMap): void
function subscribeLayoutMap(cb: (map: Readonly<LayoutMap>) => void): () => void
function addLayoutSource(source: LayoutSource, priority: number): void
const QWERTY_MAP: Readonly<LayoutMap>

type LayoutMap = Record<string, string>          // KeyboardEvent.code → character
interface LayoutSource { name: string; load(): Promise<LayoutMap> | LayoutMap }
```

The layout map learns the user's keyboard layout from observed keystrokes
(`observeKey`) and resolves physical key codes to characters (`resolveCode`),
falling back through the learned map → registered external sources →
`QWERTY_MAP`. It exists because the library needs to interpret
`KeyboardEvent.code` *without* relying on `event.key` (which AltGr / IME /
non-ASCII layouts make unreliable for binding lookup).

**The library does not persist anything.** State lives entirely in module
memory and is wiped on reload. Consumers that want learned layouts to
survive restarts wire their own serialization:

- On startup, read the stored map and call `setLayoutMap(stored)`.
- Subscribe via `subscribeLayoutMap(cb)`, debounce in the callback, and
  write to the consumer's store (IndexedDB, localStorage, file, etc.).

This keeps `@quite/semmap` free of any DOM/storage dependencies and lets
each consumer pick the storage backend that fits its host environment.

### Operator + motion emission timing (behavioral pin)

When the engine resolves a key to a `{type:'operator'}` `BindingEntry`, it enters operator-pending state and emits `{type:'pending', pendingDisplay}`. The next key that resolves to a `{type:'motion'}` entry causes the engine to emit a single `{type:'action', action, motion, count}` result combining the operator's resolved action id (from `operatorActions`), the motion name, and the accumulated counts (operator count × motion count). Operator-pending state is cleared. If the next key is not a motion (or `Esc`/`C-g`), the operator is cancelled and `{type:'unmatched'}` is emitted with no action.

## Consumers

- **quite-app** (existing): replaces `./keyboardEngine`, `./modeRegistry`,
  `./keyboard/*` imports with `@quite/semmap`. Terminal pass-target
  re-dispatch becomes a consumer-side branch in `App.tsx`'s capture handler.
- **zen-keys** (planned): consumes the package fresh.

## Out of scope

- YAML / config-file loaders.
- A pre-baked `inputScope` / passthrough-keymap builder. That depends on the
  consumer's typing-key set and the consumer's policy for which keys should
  pass through; quite-app and zen-keys will each have their own.
- Renaming `vim.delete` / `vim.change` / `vim.yank` to the new
  `engine.operator.*` ids in quite-app. Defaults preserve current behavior;
  rename is a separate, optional follow-up.

## Open follow-ups (flagged for later, not gating release)

- Prune the vestigial `Mode` / `ModeId` types in `modeRegistry.ts` once
  consumers confirm they don't reference them. The engine no longer needs
  them post-`KeymapSource` refactor.
