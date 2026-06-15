# Spec: Chord synthesis (move chord-weaving into semmap)

Status: proposed
Owner: —
Related: `KeymapConflict`, `BindingEntry`, `Keymap`, `KeyboardEngine.getConflicts`

## Summary

Add a small keymap-construction primitive to semmap that weaves a multi-key
chord (a sequence of key strings ending in an action) into a `Keymap`,
materializing inline `prefix` nodes as needed and reporting `KeymapConflict`s.
Consumers (quite-app today) currently re-implement this against semmap's own
data model; the logic belongs in the routing core that owns `BindingEntry`,
`Keymap`, and `KeymapConflict`.

## Motivation

semmap already owns the vocabulary for this operation but not the operation:

- `KeymapConflict`'s doc comment describes it as "reported by the synthesizer
  that builds engine modes," and even uses `prefix:C-x@emacs` as an example
  `modeId` — i.e. the type documents a synthesizer that does not exist in the
  library.
- `KeyboardEngine` is a **passive** conflict holder: it stores
  `options.conflicts` at construction and returns them from `getConflicts()`
  for diagnostics. It performs no detection.
- The actual weaving + conflict detection lives in the consumer
  (quite-app `buildKeybindingPreset.ts` → `applyChordToMode`), operating
  entirely on semmap types.

Two concrete problems with the current consumer-side approach, both of which
this primitive removes:

1. **A redundant side registry.** The consumer stores synthesized prefix
   sub-keymaps in a `Map<ModeId, Mode>` under invented ids
   (`prefix:<dotted-path>@<baseMode>`) purely so a later chord that shares a
   prefix can re-find and extend the same sub-keymap. But the engine never
   consumes those entries as modes — it reaches prefix continuations through
   the inline `{ type: 'prefix', keymap }` `BindingEntry` nested in the real
   mode. The side map is redundant with the inline nesting. It only exists
   because the consumer extends prefixes *by id lookup* instead of *by
   descending the inline structure*. This is the sole reason the consumer
   needs a `Mode` wrapper type at all (with its otherwise-unread `id` and a
   `type: 'persistent' | 'transient'` flag used only to skip synthesized
   entries when handing out default chords).

2. **Fragile cross-file string coupling.** quite-app's emacs preset
   (`applyEmacsCxPaneBindings`) hand-builds `prefix:C-x@${baseModeId}` ids
   *specifically to match* `applyChordToMode`'s naming convention, so the two
   sites share the same prefix object. If the formats ever drift, the
   `modes.get(prefixModeId)` lookup inside the weaver returns `undefined` and
   the chord is **silently dropped**. Inline descent eliminates both the
   shared-format contract and the silent-drop failure mode.

Moving weaving into semmap lets the consumer build plain `Map<ModeId, Keymap>`
real modes and call one function per chord — no `Mode` wrapper, no synthesized
ids, no registry.

## Non-goals

semmap is a routing core, not a config layer (see `docs/architecture.md`).
This primitive stays at the keymap level. The following remain in the consumer:

- The list of default chords and the user-config / YAML parsing that produces
  chords.
- `KeyCombo` and the `KeyCombo → KeyStr` conversion (`comboToKeyString`).
- Action-id canonicalization and the action catalog.
- The collection of modes (`Map<ModeId, Keymap>`), mode selection, and which
  modes receive which chords (the persistent/transient distinction is a
  consumer build-time concern, not a semmap concept — the engine drives
  operator-pending and chord overlays from `BindingEntry` variants, never from
  a mode flag).

## Proposed API

A single-chord primitive that mutates a root keymap in place and returns the
conflicts produced by *that* chord:

```ts
/**
 * Weave one chord into `root`, creating/descending inline `prefix` nodes.
 * `steps` is the normalized key-string path (e.g. ['C-x', 'C-f']); the chord
 * binds `action` at the leaf. Mutates `root`. Returns conflicts found for this
 * chord (empty if it wove cleanly).
 *
 * - `explicit: false` (baseline/default) — yields to any pre-existing flat
 *   binding at any step; reports the collision but does not overwrite.
 * - `explicit: true` — overwrites a pre-existing flat binding (flat action at
 *   the leaf, or a flat action sitting where the chord must descend), and
 *   reports the displaced binding as a conflict. Never overwrites a deeper
 *   prefix at the leaf (a longer, more-specific chord wins).
 *
 * `modeId` is recorded on emitted conflicts for provenance only.
 */
export function weaveChord(
  root: Keymap,
  steps: readonly KeyStr[],
  action: KeymapActionId,
  opts: { modeId: ModeId; explicit: boolean },
): KeymapConflict[]
```

Optional batch convenience (can be added later or kept consumer-side):

```ts
export function weaveChords(
  root: Keymap,
  chords: readonly { steps: readonly KeyStr[]; action: KeymapActionId; explicit: boolean }[],
  modeId: ModeId,
): KeymapConflict[]
```

Export both `weaveChord` (and optionally `weaveChords`) from the package root
alongside the existing keymap helpers.

## Behavior (must preserve current semantics)

Walk `steps` left to right against `root`, descending into prefix nodes. At
each step let `existing = current.get(keyStr)` and `path` = keys consumed so
far (inclusive).

### Leaf step (last key)

| `existing`                         | default (`explicit: false`)                          | explicit (`explicit: true`)                          |
| ---------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| none                               | bind `{ type: 'action', action }`                    | bind `{ type: 'action', action }`                    |
| `prefix`                           | **conflict** (chord-shadow); do not bind             | **conflict** (chord-shadow); do not bind             |
| `action` (same action)             | no-op                                                 | no-op                                                 |
| `action` (different action)        | **conflict** (fan-out); do not overwrite             | **conflict** (fan-out); overwrite with new action    |

- chord-shadow conflict: `flatActions = [action]`,
  `chordContinuations = sorted(keys of existing.keymap)`.
- fan-out conflict: `flatActions = sorted([existing.action, action])`,
  `chordContinuations = []`.
- A leaf `prefix` is never overwritten, even when explicit: the existing
  longer chord is more specific.

### Intermediate step

| `existing`              | action                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `prefix`                | descend into `existing.keymap` (no conflict)                                              |
| none                    | create `{ type: 'prefix', keymap: new Map }`, descend into the new keymap                 |
| `action`/other (flat)   | **conflict** (chord-shadow at intermediate). default: stop, do not modify. explicit: replace with a fresh prefix and descend. |

- intermediate chord-shadow conflict: `flatActions = [existing.action]`
  (or `['<type>:internal']` for a non-action flat entry),
  `chordContinuations = [nextKeyStr]`.

> Difference from today: descent into an existing prefix uses the inline
> `existing.keymap` directly rather than a `modes.get(prefixModeId)` lookup.
> Functionally identical for well-formed input, but removes the side registry
> and the silent-drop-on-id-mismatch path.

## `KeymapConflict` changes

With weaving operating on a single keymap, the synthesized
`prefix:<path>@<base>` id is no longer produced. Conflicts become:

- `modeId` — the real base mode id passed in (`emacs`, `insert`, …),
  for **all** conflicts including those found mid-prefix. Provenance only.
- `path` — the full normalized key path from the mode root to the conflict
  node (already the case; now it is the sole source of depth information).

This is safe for the current consumer: the only renderer of conflicts keys off
`path` + `flatActions` + `chordContinuations` and never reads `modeId`. Update
the `KeymapConflict.modeId` doc comment to drop the `prefix:C-x@emacs` example
and describe it as the originating mode id.

## Migration

**semmap**

1. Implement `weaveChord` (port `applyChordToMode`'s leaf/intermediate rules,
   replacing the id registry with inline descent).
2. Export it (and optionally `weaveChords`).
3. Tests (see below).
4. Update `KeymapConflict` doc comment.
5. Release a minor version.

**quite-app** (after semmap release)

1. `buildKeybindingPreset`: build real modes as `Map<ModeId, Keymap>`; for each
   target mode × chord call `weaveChord(keymap, comboSteps.map(comboToKeyString),
   action, { modeId, explicit })`; concat returned conflicts.
2. Re-express `presets/emacs.ts`'s `applyEmacsCxPaneBindings` as `weaveChord`
   calls (`C-x 2 → pane.split-below`, …) into the emacs/browse keymaps —
   deleting the hand-built `prefix:…@…` id coordination.
3. Decide which modes get default chords without a `type` flag (the only
   remaining use of `Mode.type`). Options: keep a small consumer-side
   `Set<ModeId>` of chord-eligible real modes, or simply iterate the real-mode
   map (which no longer contains synthesized prefix entries, so the
   `!== 'terminal'` guard is the only filter left).
4. Delete the local `Mode` type, the `prefix:*@*` registry, and the
   `type`/`id` bookkeeping. (Supersedes the interim PR that defines `Mode`
   locally.)

## Testing

Port/author table-driven cases for `weaveChord`:

- single-step chord into empty keymap (binds action)
- multi-step chord creates nested prefixes; second chord sharing the prefix
  extends the same nested keymap (inline descent reuse)
- leaf already a prefix → chord-shadow conflict, both modes, no overwrite
- leaf already a different flat action → fan-out: default yields, explicit
  overwrites, both report
- leaf already the same action → no-op, no conflict
- intermediate flat action in the path → chord-shadow: default yields,
  explicit replaces with prefix and descends
- conflict records carry correct `path`, `flatActions` (sorted where
  specified), and `chordContinuations`

## Open questions

1. **Mutate vs. return a new keymap.** Spec assumes in-place mutation (matches
   current behavior, cheap). A pure variant returning a new `Keymap` is
   possible but heavier; probably not worth it.
2. **Batch `weaveChords` in semmap or consumer?** The consumer loop is trivial;
   include it only if a second consumer wants it.
3. **Should `modeId` stay on `KeymapConflict` at all?** It is provenance-only
   and currently unread. Keeping it is harmless and aids diagnostics; dropping
   it is a further simplification but a breaking type change. Recommend keep.
