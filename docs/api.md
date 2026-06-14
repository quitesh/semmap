# API reference

The full exported surface of `@quitesh/semmap`. For the concepts behind it, see
[`architecture.md`](./architecture.md).

## Imports

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
  // layout map (in-memory; consumer owns persistence)
  observeKey,
  resolveCode,
  getLayoutMap,
  setLayoutMap,
  subscribeLayoutMap,
  addLayoutSource,
  QWERTY_MAP,
} from '@quitesh/semmap'

import type {
  KeyEvent,
  EngineResult,
  EngineState,
  KeymapSource,
  KeymapConflict,
  BindingEntry,
  Keymap,
  KeyStr,
  ActionId,
  KeymapActionId,
  HandlerActionId,
  SemanticActionId,
  SemanticActionRemaps,
  ActionRemap,
  Scope,
  ActionArgs,
  HandlerFn,
  EngineResultLike,
  LayoutMap,
  LayoutSource,
  Mode,       // vestigial; carried for parity, prune later
  ModeId,     // vestigial; carried for parity, prune later
} from '@quitesh/semmap'

import { vimGrammar } from '@quitesh/semmap/presets/vim'
import { emacsGrammar } from '@quitesh/semmap/presets/emacs'
```

Presets ship as separate subpath exports — there is no combined `presets`
barrel, so a consumer that uses only one preset pays nothing for the other.

## Discriminated unions

```ts
interface EngineResult {
  type:
    | 'action'         // resolved to a semantic/keymap action
    | 'passthrough'    // not the engine's key — consumer decides
    | 'pending'        // mid-chord / operator-pending
    | 'unmatched'      // no binding; let the native event through
    | 'composing'      // IME composition in progress
    | 'chordCancelled' // dead prefix-chord; key is eaten, caller must preventDefault
  action?: string
  motion?: string
  count?: number
  pendingDisplay?: string    // status line: "3d", "C-x ", …
  cancelledDisplay?: string  // chordCancelled: keys pressed, e.g. "C-x q"
}

type BindingEntry =
  | { type: 'action'; action: KeymapActionId }
  | { type: 'operator'; operator: string }
  | { type: 'motion'; motion: string }
  | { type: 'prefix'; keymap: Keymap }
  | { type: 'passthrough' }
```

`Keymap` is `Map<KeyStr, BindingEntry>`.

## `KeyboardEngine`

```ts
class KeyboardEngine {
  constructor(
    source: KeymapSource,
    options?: {
      conflicts?: readonly KeymapConflict[]
      prefixTimeoutMs?: number                    // default 1000
      operatorActions?: Record<string, string>    // default { d: Actions.OPERATOR_DELETE, c: …, y: … }
      universalArgAction?: string                 // default Actions.UNIVERSAL_ARG
    }
  )

  processKey(e: KeyEvent): EngineResult
  peekProcessKey(e: KeyEvent): EngineResult   // snapshot/restore for parity tests; no mutation, no notify
  getState(): EngineState
  peekState(): EngineState                    // alias of getState; pinned for compat
  subscribe(cb: () => void): () => void       // observe for status-line / which-key widgets
  getConflicts(): readonly KeymapConflict[]
  reset(): void
  onKeymapSourceChanged(): void               // call when the source swaps; clears grammar overlay
  dispose(): void                             // clears the pending chord timer
}

interface EngineState {
  currentMode: ModeId
  pendingDisplay: string   // "3d", "C-x ", …
}
```

## `ScopeStack`

`ScopeStack` is the canonical `KeymapSource` — the source the engine reads
from.

```ts
class ScopeStack implements KeymapSource {
  pushOrUpdate(scope: Scope): void   // identity by scope.id; replaces in place if present, else pushes to top
  pop(id: string): void
  snapshotIds(): string[]            // bottom→top, for diagnostics

  // KeymapSource (the engine calls these)
  iterateKeymaps(): Iterable<Keymap> // top-down walk, respecting the claimsInput floor
  acceptsLeadingCount(): boolean     // true when the topmost active scope sets it

  // Dispatch helpers (call after the engine emits an 'action' result)
  walkRemap(action: KeymapActionId): HandlerActionId             // recursive semantic→concrete resolution
  walkHandler(action: HandlerActionId, args?: ActionArgs): boolean // returns true if claimed
  dispatchAction(action: HandlerActionId, args?: ActionArgs): boolean // walkRemap + walkHandler, ignoring claimsInput

  subscribe(cb: () => void): () => void
}

interface Scope {
  id: string
  keymap?: Keymap                  // key → BindingEntry; discouraged outside passthrough scopes
  semanticKeymap?: Keymap          // visible through a claimsInput floor for global semantic actions
  remaps?: ActionRemap             // semantic → concrete, per scope
  handlers?: ReadonlyMap<HandlerActionId, HandlerFn>
  claimsInput?: boolean            // scopes below are hidden (except their semanticKeymap)
  acceptsLeadingCount?: boolean    // digit keys accumulate as a count (vim normal/visual)
}

interface ActionArgs {
  count?: number
  motion?: string
}

type HandlerFn   = (action: HandlerActionId, args: ActionArgs) => boolean
type ActionRemap = ReadonlyMap<ActionId, HandlerActionId>
```

## `Dispatcher`

A thin convenience wrapper around `ScopeStack`. One method:

```ts
class Dispatcher {
  constructor(stack: ScopeStack)
  dispatch(result: EngineResultLike, e: KeyboardEvent): boolean
  // walks remap + handler for an 'action' result; returns true if claimed, false otherwise
}
```

`dispatch` takes an `EngineResultLike` (a structural subset of `EngineResult`).
Consumers may bypass `Dispatcher` entirely and call `ScopeStack.walkRemap` /
`walkHandler` directly when the dispatch flow needs to inspect the result first
or route `passthrough` itself.

## `KeymapSource`

```ts
interface KeymapSource {
  iterateKeymaps(): Iterable<Keymap>   // top-down; engine walks until first hit
  acceptsLeadingCount(): boolean
}
```

`ScopeStack` is the canonical implementation. Implement your own for tests or
for non-scope-based dispatch.

## `Actions`

```ts
const Actions = {
  OPERATOR_DELETE: 'vim.delete',
  OPERATOR_CHANGE: 'vim.change',
  OPERATOR_YANK:   'vim.yank',
  UNIVERSAL_ARG:   'action.universalArgument',
} as const
```

These *are* the default literal action id strings the engine emits. Defaults
map `{ d → OPERATOR_DELETE, c → OPERATOR_CHANGE, y → OPERATOR_YANK }` for
operators and emit `UNIVERSAL_ARG` for `C-u`. Override via the
`operatorActions` / `universalArgAction` constructor options; reference the
`Actions.*` constants in your remaps to match whatever the engine emits. The
`vim.*` prefix on the operator defaults is a historical accident — non-vim
consumers reference the constants, not the bare strings, so it does not leak.

## Presets

```ts
// @quitesh/semmap/presets/vim
function vimGrammar(): { normal: Keymap; insert: Keymap; opPending: Keymap }

// @quitesh/semmap/presets/emacs
function emacsGrammar(): Keymap
```

Each returns bare grammar fragments — keymaps binding the vim
operators/motions/counts or the emacs chord prefixes and universal-argument
key. Consumers compose these into their own scope keymaps (overlay app-specific
binds on top).

## `defineSemanticActionRemaps` / `isSemanticActionId`

```ts
function defineSemanticActionRemaps(remaps: SemanticActionRemaps): ActionRemap
function isSemanticActionId(id: string): id is SemanticActionId
```

`defineSemanticActionRemaps` builds the semantic → concrete routing table a
scope installs as its `remaps`. `isSemanticActionId` is the type guard for
distinguishing semantic ids from concrete handler ids.

## `setEngineKeyResult` / `getEngineKeyResult`

```ts
function setEngineKeyResult(e: KeyEvent | KeyboardEvent, result: EngineResult): void
function getEngineKeyResult(e: KeyEvent | KeyboardEvent): EngineResult | undefined
```

Caches the engine's verdict on the event itself (via a private symbol property)
so downstream capture handlers can read it without re-running `processKey` —
saving CPU and preventing state drift when multiple handlers fire on one event.

## Key normalization

```ts
function normalizeKeyEvent(e: KeyboardEvent): KeyEvent  // → engine-facing KeyEvent
function resolveBaseKey(e: KeyEvent): string            // layout-aware base-key string
```

## Layout map

In-memory; the consumer owns persistence (see
[`architecture.md`](./architecture.md#layout-map)).

```ts
function observeKey(code: string, key: string): void
function resolveCode(code: string): string | undefined
function getLayoutMap(): Readonly<LayoutMap>
function setLayoutMap(map: LayoutMap): void
function subscribeLayoutMap(cb: (map: Readonly<LayoutMap>) => void): () => void
function addLayoutSource(source: LayoutSource, priority: number): void
const QWERTY_MAP: Readonly<LayoutMap>

type LayoutMap = Record<string, string>   // KeyboardEvent.code → character
interface LayoutSource { name: string; load(): Promise<LayoutMap> | LayoutMap }
```

## Vestigial types

`Mode` and `ModeId` (from the pre-`KeymapSource` engine) are exported for API
parity but are no longer load-bearing. They are slated for removal once
consumers confirm they reference neither; new code should not depend on them.
