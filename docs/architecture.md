# Architecture

`semmap` routes a keystroke to a handler in three layers, each owned by a
scope on a stack and walked top-of-stack first:

1. **Keymap** — physical keystroke → semantic action id (`j` → `action.down`).
2. **Per-scope remap** — semantic id → concrete handler id (`action.down` →
   `list.next` in a list scope; `cursor.down` in an editor scope).
3. **Per-scope handler** — concrete id → consumer-registered function.

The split between layers 1 and 2 is the point of the library. A keymap emits
*semantic* actions ("move down", "cancel", "submit") that mean the same thing
everywhere; each scope then *remaps* those to its own concrete handlers. One
keybinding (`Escape → action.cancel`) routes to `modal.close` in a modal and
`vim.enterNormal` in an editor without the keymap knowing either exists.

`semmap` is a routing core, not a UI framework. Focus management, action
catalogs, config loading, and per-app dispatch policy all stay in the consumer.

## Pipeline

```
Key event
  │
  ▼
KeyboardEngine.processKey
  │  IME gate (e.isComposing → { type: 'composing' })
  │  grammar overlay? (operator-pending / prefix-chord)
  │  walk ScopeStack keymaps top-down → EngineResult
  │
  ▼
Dispatcher.dispatch  (or call ScopeStack.walkRemap/walkHandler directly)
  │  action       → walkRemap → walkHandler (top-down scope walk)
  │  passthrough  → not ours; consumer decides (type into input, send to PTY, …)
  │  pending / unmatched / composing / chordCancelled → no-op
  ▼
Handler / consumer passthrough branch / browser default
```

The engine answers one question — "whose key is this, and what does it mean?"
— and the dispatcher (or the consumer) acts on the answer.

## Action id vocabulary

Routing uses two kinds of action id deliberately:

- **Semantic / keymap actions** are what keymaps emit *before* remapping:
  `action.cancel`, `action.submit`, `action.up`, `action.down`. User
  keybindings point at these when one physical key should mean "cancel" /
  "submit" / "move up" across every surface.
- **Concrete handler actions** are what scopes handle *after* remapping:
  `modal.close`, `form.submit`, `list.next`. Handler maps use these
  domain-specific ids.

`defineSemanticActionRemaps` builds the semantic → concrete routing tables a
scope installs as its `remaps`.

## Scope stack

`ScopeStack` holds an ordered list of scope frames. Bottom = lowest priority;
top = highest. Each frame is a `Scope`:

```ts
interface Scope {
  id: string
  keymap?: Keymap                 // physical key → BindingEntry (semantic/keymap action)
  semanticKeymap?: Keymap         // semantic bindings visible through a claimsInput floor
  remaps?: ActionRemap            // semantic/keymap action → concrete handler action
  handlers?: ReadonlyMap<HandlerActionId, HandlerFn>
  claimsInput?: boolean           // truncate normal keymap/remap/handler walks here
  acceptsLeadingCount?: boolean   // leading digits accumulate as a count (vim normal/visual)
}
```

- **`pushOrUpdate(scope)`** — identity by `id`. If a scope with the same id is
  already on the stack, its fields are updated in place (no reorder).
  Subscribers are notified only when resolution-affecting state changes.
- **`pop(id)`** — removes the scope; no-op if absent.

### `claimsInput` — the modal floor

When a scope sets `claimsInput`, the topmost such scope is the **floor**:
normal keymap, remap, and handler walks ignore every scope below it. This is
how a modal stops app-global actions from firing while it is open.

The exception is `semanticKeymap`: semantic keymaps below the floor *still*
pass through. So `Escape` can resolve to `action.cancel` for a modal even when
the active preset's normal keymap would otherwise bind it to a mode-specific
action — the modal remaps `action.cancel → modal.close` without installing a
keymap of its own. Surfaces that contribute only `remaps` + `handlers` (and no
keymap) are the common case; a new keymap on a modal/menu scope is a smell.

### `acceptsLeadingCount`

When the topmost active scope sets this, leading digit keys accumulate as a
count prefix (`3j`). Vim normal/visual scopes set it; emacs and insert-style
scopes leave it unset.

## Engine

`KeyboardEngine` is stateless with respect to scope composition — it reads
keymaps from a `KeymapSource` (`ScopeStack` is the canonical one). It owns:

- **IME gate** — `e.isComposing` is checked at `processKey` entry and returns
  `{ type: 'composing' }` immediately, so composition keystrokes never route.
- **Grammar overlays** — at most one active at a time:
  - *operator-pending* — a vim `operator` binding captures the next key as a
    motion; the two combine into one `action` result.
  - *prefix-chord* — a `prefix` binding captures a continuation keymap; the
    next key resolves against it, with a timeout (default 1 s).
- **Count / universal-argument** accumulation.
- **Keymap resolution** — walks `source.iterateKeymaps()` top-down; the first
  visible keymap that binds the key wins. An active overlay keymap takes
  precedence over the scope walk. `claimsInput` hides lower *normal* keymaps
  but not lower *semantic* keymaps.

Grammar overlay state clears whenever the keymap source changes (push, pop,
reorder, or any scope publishing a new keymap — e.g. a vim mode flip). Call
`engine.onKeymapSourceChanged()` if you swap the source out from under it.

### `EngineResult`

```ts
interface EngineResult {
  type:
    | 'action'         // resolved to a semantic/keymap action
    | 'passthrough'    // not the engine's key — consumer decides
    | 'pending'        // mid-chord or operator-pending; show pendingDisplay
    | 'unmatched'      // no binding; let the native event through
    | 'composing'      // IME composition in progress
    | 'chordCancelled' // active prefix-chord hit an unbound key; key is EATEN
  action?: string
  motion?: string
  count?: number
  pendingDisplay?: string   // for a status line: "3d", "C-x ", …
  cancelledDisplay?: string // for chordCancelled: keys pressed, e.g. "C-x q"
}
```

`unmatched` and `chordCancelled` have opposite contracts: `unmatched` means
"let the native event reach the input"; `chordCancelled` means the key was
consumed by a dead chord, so the consumer must `preventDefault` /
`stopPropagation` rather than let it type.

### `passthrough` — why there is no `passToInput` / `passToTerminal`

The engine emits a single `{ type: 'passthrough' }` for "this key isn't mine."
It does **not** distinguish "send to the text input" from "send to a terminal"
— the consumer already knows what to do based on current focus / active scope.
Encoding destinations in the engine would leak app-specific routing into a
generic library. The consumer branches on `passthrough` and routes the
keystroke itself (type into a CodeMirror, ship PTY bytes, etc.).

## Dispatcher

`Dispatcher` is a thin convenience wrapper around `ScopeStack`:

```ts
const dispatcher = new Dispatcher(stack)
if (dispatcher.dispatch(result, e)) e.preventDefault()
```

`dispatch` walks remap + handler for an `action` result (respecting the
`claimsInput` floor) and returns `true` if a handler claimed it; for every
other result type it returns `false`. Consumers that need to inspect the
result first — or route `passthrough` themselves — can skip `Dispatcher` and
call `ScopeStack.walkRemap` / `walkHandler` directly. Both are public.

## Vim grammar

The vim preset binds operators, motions, and counts as grammar entries the
engine assembles:

- An `operator` binding (`d`, `c`, `y`) puts the engine in operator-pending
  state and emits `{ type: 'pending' }`.
- The next key that resolves to a `motion` binding produces a single
  `{ type: 'action', action, motion, count }`, combining the operator's
  resolved action id, the motion name, and the product of the operator and
  motion counts (`2d3w` → count 6).
- A non-motion next key (other than `Esc` / `C-g`) cancels the operator and
  emits `unmatched`.

The operator → action mapping is configurable. The exported `Actions`
constants *are* the default literal action ids, so a consumer overriding
`operatorActions` / `universalArgAction` in the `KeyboardEngine` constructor
can still reference `Actions.OPERATOR_DELETE` etc. to match the defaults.

Mode switching is not magic: vim modes are plain action bindings
(`i → vim.enterInsert`, `Esc → vim.enterNormal`). The consumer's handler for
those actions republishes the scope's keymap (normal → insert); the engine
sees the new keymap on the next `processKey` and clears any pending overlay.

## Layout map

The library interprets `KeyboardEvent.code` rather than `event.key`, because
AltGr / IME / non-ASCII layouts make `key` unreliable for binding lookup. The
layout map learns the user's layout from observed keystrokes (`observeKey`) and
resolves physical codes to characters (`resolveCode`), falling back through the
learned map → registered external sources → `QWERTY_MAP`.

**The library persists nothing.** Layout state lives in module memory and is
wiped on reload. A consumer that wants learned layouts to survive restarts
calls `setLayoutMap(stored)` on startup and subscribes via
`subscribeLayoutMap(cb)` to write changes back to its own store (IndexedDB,
localStorage, a file — the library stays free of DOM/storage dependencies).

See [`api.md`](./api.md) for the full exported surface.
