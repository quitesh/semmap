# `@quitesh/semmap` — Extraction Plan

**Companion to:** `docs/superpowers/specs/2026-05-28-semmap-design.md`
**Date:** 2026-05-28
**Target:** publish `@quitesh/semmap@0.1.0` and migrate `quite-app` to consume it.

This plan is phased and file-by-file. Each phase lists rationale, files
touched (absolute paths), verification command, and dependencies. The repo at
`/home/sauyon/devel/semmap/` already exists (empty, `git init` done — no
first commit yet).

## Manual prerequisites (user, before phase 7)

- Create the `@quite` npm org and grant publish access to the user's account.
  The agent cannot do this — it requires npm web auth.
- Confirm `pnpm` is on PATH at the publish step.

The user may also choose, separately, whether to preserve git history via
`git filter-repo` from `quite-app`. This plan copies files plain — preserving
history is optional and orthogonal.

---

## Phase 1: Bootstrap the package

**Rationale.** Get a buildable, testable empty shell before moving any code.
Avoids debugging both the build harness and the source migration at once.
Lives at `/home/sauyon/devel/semmap/` (sibling repo, not a workspace inside
quite-app — confirmed earlier).

**Files created (all absolute):**

- `/home/sauyon/devel/semmap/package.json`
  ```json
  {
    "name": "@quitesh/semmap",
    "version": "0.1.0",
    "description": "Semantic keystroke routing engine: keymap → semantic action → per-scope remap → handler.",
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
      "./presets/vim": { "types": "./dist/presets/vim.d.ts", "import": "./dist/presets/vim.js" },
      "./presets/emacs": { "types": "./dist/presets/emacs.d.ts", "import": "./dist/presets/emacs.js" }
    },
    "files": ["dist", "README.md", "LICENSE"],
    "publishConfig": { "access": "public" },
    "scripts": {
      "build": "tsc -p tsconfig.json",
      "test": "vitest run",
      "test:watch": "vitest",
      "typecheck": "tsc --noEmit",
      "prepublishOnly": "pnpm run build && pnpm run test"
    },
    "devDependencies": {
      "typescript": "^6.0.3",
      "vitest": "^4.1.5"
    }
  }
  ```
- `/home/sauyon/devel/semmap/tsconfig.json` — `strict: true`, `module: "nodenext"`,
  `target: "es2022"`, `moduleResolution: "nodenext"`, `declaration: true`,
  `outDir: "./dist"`, `rootDir: "./src"`, `include: ["src/**/*.ts"]`,
  `exclude: ["src/**/*.test.ts", "src/**/__tests__/**"]`. Mirror the version
  constraints quite-app uses (TS 6, Vitest 4) so behavior is identical.

  `nodenext` (not `bundler`) is deliberate: the package is consumed both by
  bundler shops (quite-app via Vite) and by plain Node ESM (vitest workers,
  potential zen-keys host code). `bundler` resolution emits extensionless
  relative imports in `dist/`, which Node's native ESM rejects with
  `ERR_MODULE_NOT_FOUND`. `nodenext` requires `.js` extensions on relative
  imports in source (TypeScript will check this) and emits them verbatim,
  so the compiled `dist/` is loadable by every ESM consumer with no extra
  bundler config.
- `/home/sauyon/devel/semmap/vitest.config.ts` — minimal: `defineConfig({ test: { environment: 'node' } })`. The engine has no DOM dependencies.
- `/home/sauyon/devel/semmap/LICENSE` — MIT (matches the assumed quite-app license; confirm with user before publish).
- `/home/sauyon/devel/semmap/README.md` — stub. One paragraph summary + install + minimal usage snippet (pointing to the design doc).
- `/home/sauyon/devel/semmap/.gitignore` — `node_modules/`, `dist/`, `*.log`, `.DS_Store`.
- `/home/sauyon/devel/semmap/src/index.ts` — empty barrel for now (`export {}`).
- `/home/sauyon/devel/semmap/src/presets/vim.ts` — empty stub (`export {}`); populated in phase 2.
- `/home/sauyon/devel/semmap/src/presets/emacs.ts` — empty stub (`export {}`); populated in phase 2.

No combined `src/presets/index.ts` barrel — the two presets ship as separate
subpath exports (`@quitesh/semmap/presets/vim`, `@quitesh/semmap/presets/emacs`)
per the design doc. Stubbing the files now lets the `exports` map in
`package.json` resolve cleanly during the bootstrap build.

**Verification.**

```sh
cd /home/sauyon/devel/semmap
pnpm install
pnpm run build       # produces dist/index.js, dist/presets/vim.js, dist/presets/emacs.js
pnpm run typecheck
pnpm run test        # 0 tests, exits clean
```

**Dependencies:** none.

---

## Phase 2: Copy source files unchanged

**Rationale.** Move bits verbatim first; refactor in phase 3. Keeping the
"copy" and "refactor" steps separate makes diffs reviewable. Tests aren't
copied yet because the refactor in phase 3 will rewrite parts of them.

**File-by-file copy map** (source → destination, all absolute):

| Source (quite-app) | Destination (semmap) |
|---|---|
| `/home/sauyon/devel/quite-app/quitesh/src/keyboardEngine.ts` | `/home/sauyon/devel/semmap/src/keyboardEngine.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/modeRegistry.ts` | `/home/sauyon/devel/semmap/src/modeRegistry.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/layoutMap.ts` | `/home/sauyon/devel/semmap/src/layoutMap.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/keymap.ts` | `/home/sauyon/devel/semmap/src/keyboard/keymap.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/scopeStack.ts` | `/home/sauyon/devel/semmap/src/keyboard/scopeStack.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/dispatcher.ts` | `/home/sauyon/devel/semmap/src/keyboard/dispatcher.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/engineKeyEvent.ts` | `/home/sauyon/devel/semmap/src/keyboard/engineKeyEvent.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/presets/vim.ts` | `/home/sauyon/devel/semmap/src/presets/vim.ts` |
| `/home/sauyon/devel/quite-app/quitesh/src/presets/emacs.ts` | `/home/sauyon/devel/semmap/src/presets/emacs.ts` |

**Notes on the copy step**

- `presets/emacs.ts` currently imports from `../keybindings` (quite-app's
  action catalog). That import will be cut in phase 3 — for the verbatim copy
  it's expected to be a temporarily broken import.
- `dispatchPassTarget.ts` and `buildInputScopeKeymap.ts` are **not** copied —
  they stay in quite-app (consumer code; see design doc).
- `keyboard/editOps.ts`, `keyboard/textInputActions.ts`,
  `keyboard/shellEnginePostKey.ts`, `keyboard/focusContext.ts`,
  `keyboard/useScope.ts`, `keyboard/useSemanticKeymap.ts`,
  `keyboard/useKeyboardConflicts.ts`, `keyboard/useModalFocusNav.ts` are
  **not** copied — they stay in quite-app (React glue / app-specific action
  implementations).

**Verification.**

```sh
cd /home/sauyon/devel/semmap
pnpm run typecheck    # WILL fail: presets/emacs.ts and presets/vim.ts have
                      # cross-imports into quite-app, and the barrels are
                      # still empty. This is expected; phase 3 fixes it.
```

A `find src -name '*.ts' -not -name '*.test.ts' | wc -l` should report 9.

**Dependencies:** Phase 1.

---

## Phase 3: Apply the three API refactors

**Rationale.** Each refactor is independent and small enough to do in one
pass. Doing them together (rather than ship-broken-then-fix) keeps the public
surface stable from the first time tests run.

### 3a. Unify pass-through types

**Files touched (all absolute):**

- `/home/sauyon/devel/semmap/src/keyboard/keymap.ts`
- `/home/sauyon/devel/semmap/src/modeRegistry.ts`
- `/home/sauyon/devel/semmap/src/keyboardEngine.ts`
- `/home/sauyon/devel/semmap/src/keyboard/dispatcher.ts`

**Diff in prose:**

- In `keyboard/keymap.ts`: replace the `BindingEntry` variants
  `{ type: 'passToInput' }` and `{ type: 'passToTerminal' }` with a single
  `{ type: 'passthrough' }`. Drop the doc comment lines that distinguish
  input vs terminal.
- In `modeRegistry.ts`: same change to the duplicate `BindingEntry` definition.
  (The two definitions exist for legacy reasons; leave both unified for
  this release rather than collapsing them, to minimize risk. Mark the
  `modeRegistry.ts` copy with a TODO to remove.)

  **Drift hazard, flagged explicitly.** After this refactor, two parallel
  `BindingEntry` definitions exist. Any future change to the variant set
  MUST be applied to both, or downstream consumers will see one definition
  win at the type level and behave unexpectedly at runtime. Pruning the
  `modeRegistry.ts` copy (see Open follow-ups in the design doc) closes
  this hazard.
- In `keyboardEngine.ts`: replace `EngineResult.type` values `'passToInput'`
  and `'passToTerminal'` with the single `'passthrough'`. Anywhere the engine
  produces these results (search for `passToInput` / `passToTerminal` —
  there are emit points inside `resolveKey`), change to `passthrough`.
- In `keyboard/dispatcher.ts`: delete `PassTargetName`, `PassTargetHandler`,
  the `passTargets` field, `registerPassTarget`, and `invokePassTarget`. In
  `dispatch`, remove the `passToInput` / `passToTerminal` cases — the
  default branch (returns `false`) handles `passthrough`.
  `EngineResultLike.type` shrinks accordingly.

**Tests that need updating in phase 4:**

- `keyboard/__tests__/dispatcher.test.ts` — all the `registerPassTarget` /
  `passToInput` / `passToTerminal` cases are deleted or rewritten as
  "dispatcher returns `false` for passthrough" assertions.
- `keyboard/__tests__/dispatchPassTarget.test.ts` — does not port to the
  library (the function itself stayed in quite-app); a slimmed copy goes
  back to quite-app in phase 5.
- `__tests__/keyboardEngine.test.ts` — search/replace `passToInput` /
  `passToTerminal` → `passthrough`.

### 3b. Preset action constants, overridable

**Files touched:**

- `/home/sauyon/devel/semmap/src/keyboardEngine.ts`
- `/home/sauyon/devel/semmap/src/index.ts` (export the constants)

**Diff in prose:**

- Add the exported constants at the top of `keyboardEngine.ts`. **The constants
  ARE the default strings** — consumers using `Actions.OPERATOR_DELETE` get
  the exact value the default mapping emits. This deliberately preserves
  quite-app's existing action ids (`vim.delete`, `action.universalArgument`)
  so its tests pass without renaming.

  ```ts
  export const Actions = {
    OPERATOR_DELETE: 'vim.delete',
    OPERATOR_CHANGE: 'vim.change',
    OPERATOR_YANK:   'vim.yank',
    UNIVERSAL_ARG:   'action.universalArgument',
  } as const
  ```

- Replace the module-level `OPERATOR_TO_ACTION` const with a constructor-fed
  field whose default references the `Actions` constants directly:

  ```ts
  constructor(
    source: KeymapSource,
    options: {
      conflicts?: readonly KeymapConflict[]
      prefixTimeoutMs?: number
      operatorActions?: Record<string, string>  // 'd' | 'c' | 'y' → action id
      universalArgAction?: string                // emits this on C-u resolution
    } = {},
  )
  ```

  Default body:

  ```ts
  this.operatorActions = options.operatorActions ?? {
    d: Actions.OPERATOR_DELETE,
    c: Actions.OPERATOR_CHANGE,
    y: Actions.OPERATOR_YANK,
  }
  this.universalArgAction = options.universalArgAction ?? Actions.UNIVERSAL_ARG
  ```

  Use `this.operatorActions[operator]` everywhere the engine currently reads
  `OPERATOR_TO_ACTION[operator]`. Replace the hardcoded
  `entry.action === 'action.universalArgument'` check in `handleEntry` with
  `entry.action === this.universalArgAction`.

**Tests:** no changes needed in `__tests__/keyboardEngine.test.ts` — defaults
emit the same strings as today.

### 3c. Ship preset grammar fragments

**Files touched:**

- `/home/sauyon/devel/semmap/src/presets/vim.ts`
- `/home/sauyon/devel/semmap/src/presets/emacs.ts`
- `/home/sauyon/devel/semmap/src/index.ts`

**Diff in prose:**

- `presets/emacs.ts`: cut the dependency on `../keybindings` (`DEFAULT_BINDINGS`,
  `comboToKeyString`). The library should ship a bare emacs *grammar fragment*
  — the engine-relevant bits only:
  - the `C-u` → `action.universalArgument` binding
  - the `C-x` prefix scaffold (`type: 'prefix'`, empty continuation
    keymap that consumers fill in)
  - basic motion + cancel keys (`C-g`, `Escape`, `C-a`/`C-e`, etc.) that are
    universal across emacs configs

  Quite-app's `buildKeybindingPreset.ts` continues to compose the full
  default keymap from `DEFAULT_BINDINGS` (quite-app's action catalog) — the
  library no longer owns that.

  Export a single function `emacsGrammar()` returning `Map<KeyStr, BindingEntry>`.

- `presets/vim.ts`: drop the `Mode`/`ModeId`/`PresetResult` scaffolding,
  drop the `GLOBAL_BINDINGS` (quite-app actions like `tab.new`,
  `palette.open` — those are consumer responsibilities). Keep the grammar
  bits: motions, operators, simple commands (`x`, `p`, `P`), navigation
  (`h`/`j`/`k`/`l`), `i`/`a`/`I`/`A` (insert entries, emitted as actions
  named `vim.enterInsert` by default — overridable later if needed).

  Export `vimGrammar(): { normal: Keymap; insert: Keymap; opPending: Keymap }`.
  The three keymaps are the engine-relevant primitives; the consumer composes
  modes / scopes around them.

- No combined `presets/index.ts` barrel — `vimGrammar` is reached via
  `@quitesh/semmap/presets/vim`, `emacsGrammar` via `@quitesh/semmap/presets/emacs`.
  The two subpath exports declared in phase 1's `package.json` are the only
  way to import them.
- `src/index.ts`: barrel re-exports for `KeyboardEngine`, `ScopeStack`,
  `Dispatcher`, `normalizeKeyEvent`, `resolveBaseKey`, `Actions`,
  `setEngineKeyResult`, `getEngineKeyResult`, `defineSemanticActionRemaps`,
  and type-only re-exports for `KeyEvent`, `EngineResult`, `BindingEntry`,
  `Keymap`, `KeyStr`, `ActionId`, `KeymapActionId`, `HandlerActionId`,
  `KeymapSource`, `Scope`, `HandlerFn`, `ActionArgs`, `ActionRemap`,
  `KeymapConflict`, `EngineState`. (The type-only list mirrors the spec's
  imports block — if `resolveBaseKey` is not actually exported by
  `modeRegistry.ts` in the current quite-app source, drop it; the spec lists
  only what the library promises consumers will see.)

**Tests:** `vimPreset.test.ts` from quite-app exercises the old
`buildVimPreset` mode-graph shape. Port a slimmed version that asserts
`vimGrammar()` returns the expected motion/operator entries; the
mode-composition assertions stay in quite-app's `buildKeybindingPreset.ts`
tests.

**Verification.**

```sh
cd /home/sauyon/devel/semmap
pnpm run typecheck   # passes now: no more dangling imports
pnpm run build       # passes
```

**Dependencies:** Phase 2.

---

## Phase 4: Port the tests

**Rationale.** The library needs its own test surface so regressions inside
`@quitesh/semmap` are caught before publish. Filter quite-app tests to the
engine-internals slice; quite-app-specific tests stay home.

### Tests that port (copy → adapt imports)

| Source | Destination | Notes |
|---|---|---|
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/__tests__/scopeStack.test.ts` | `/home/sauyon/devel/semmap/src/keyboard/__tests__/scopeStack.test.ts` | Pure engine; verbatim |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/__tests__/dispatcher.test.ts` | `/home/sauyon/devel/semmap/src/keyboard/__tests__/dispatcher.test.ts` | Strip `passToInput` / `passToTerminal` cases (see 3a) |
| `/home/sauyon/devel/quite-app/quitesh/src/__tests__/layoutMap.test.ts` | `/home/sauyon/devel/semmap/src/__tests__/layoutMap.test.ts` | Pure; verbatim |
| `/home/sauyon/devel/quite-app/quitesh/src/__tests__/keyboardEngine.test.ts` | `/home/sauyon/devel/semmap/src/__tests__/keyboardEngine.test.ts` | Search/replace `passToInput`/`passToTerminal` → `passthrough`. The test factory uses `buildEmacsPreset` / `buildVimPreset` — these are quite-app-only and don't get ported. Replace with **inline minimal keymaps** purpose-built for the test: a `makeNormalSource(binds)` helper that constructs a `ScopeStack` with one scope containing the given binds. The current tests primarily exercise the engine's grammar state machine (operator+motion, counts, chord prefixes, universal-arg), so the inline keymaps only need the operator/motion/prefix entries the assertion exercises. Roughly ~40 LOC of test-only scaffolding to replace the preset-builder dependency. |
| `/home/sauyon/devel/quite-app/quitesh/src/__tests__/vimPreset.test.ts` | `/home/sauyon/devel/semmap/src/presets/__tests__/vim.test.ts` | Slim to grammar-fragment assertions only |
| `/home/sauyon/devel/quite-app/quitesh/src/keyboard/__tests__/buildInputScopeKeymap.test.ts` | NOT PORTED — `buildInputScopeKeymap` lives in quite-app. The test stays there and gets adapted to the new `passthrough` type in phase 5. |

### Tests that stay in quite-app (do NOT port)

These exercise quite-app-specific surfaces (React, action catalog, YAML
overrides, focus DOM, terminal):

- `__tests__/roverKeyboard.test.ts`, `RoverKeyboardScope.test.tsx`
- `__tests__/shellEnginePostKey.test.ts`
- `__tests__/textInputActions.test.ts`
- `__tests__/keybindings.test.ts`, `keybindingsYamlOverride.test.ts`,
  `keybindParity.test.ts`
- `__tests__/vimNormalGuard.test.ts`, `vimModes.test.tsx`
- `__tests__/aiPromptMode.test.ts`
- `keyboard/__tests__/focusContext.test.ts`,
  `keyboard/__tests__/useScope.test.tsx`,
  `__tests__/useModalFocusNav.test.tsx`
- `__tests__/keyboardProvider.test.tsx`, `__tests__/perPaneEngine.test.tsx`
- All `*KeyboardScope.test.tsx` files

### Import rewrites in ported tests

All ported tests have their imports rewritten from quite-app relative paths
to library paths:

- `from '../keyboardEngine'` → `from '../keyboardEngine'` (local within
  the new src tree, unchanged)
- `from '../../modeRegistry'` → `from '../../modeRegistry'` (still local)
- Tests sometimes reference quite-app-only types (e.g. `KeyCombo`). Drop the
  reference or inline a minimal substitute.

**Verification.**

```sh
cd /home/sauyon/devel/semmap
pnpm run test
```

Expected: all ported tests green.

**Dependencies:** Phase 3.

---

## Phase 5: Migrate quite-app to consume the package

**Rationale.** Validates the library's API against its primary consumer
*before* npm publish. Catches missing exports and behavior drift while a
local-path / linked install is cheap.

### 5a. Wire the package as a local file dependency (temporary)

Until phase 7 publish, add `@quitesh/semmap` to `quitesh/package.json` as
`"@quitesh/semmap": "file:../../semmap"`. After publish, the user swaps it for
`^0.1.0`.

```sh
# in /home/sauyon/devel/quite-app
pnpm add -F quitesh @quitesh/semmap@file:../../semmap
```

### 5b. Rewrite imports

Each quite-app file below has its imports rewritten. Path on the left =
file; on the right = old → new import lines (truncated to the relevant
specifiers).

| File | Rewrite |
|---|---|
| `quitesh/src/keyboardEngine.ts` | DELETE — re-export from `@quitesh/semmap` if anything still imports the local path; ideally delete and update consumers |
| `quitesh/src/modeRegistry.ts` | DELETE (or thin re-export shim) |
| `quitesh/src/layoutMap.ts` | DELETE (or re-export shim if needed for layout-settings UI) |
| `quitesh/src/keyboard/keymap.ts` | DELETE |
| `quitesh/src/keyboard/scopeStack.ts` | DELETE |
| `quitesh/src/keyboard/dispatcher.ts` | DELETE |
| `quitesh/src/keyboard/engineKeyEvent.ts` | DELETE |
| `quitesh/src/presets/vim.ts` | Replace with thin adapter: import `vimGrammar` from `@quitesh/semmap/presets/vim`, compose the `Mode` graph quite-app currently expects on top of it |
| `quitesh/src/presets/emacs.ts` | Same shape: import `emacsGrammar` from `@quitesh/semmap/presets/emacs`, layer `DEFAULT_BINDINGS` and `C-x` pane bindings on top |

Files whose source stays in quite-app but import from the deleted modules:

| File | Old import → New |
|---|---|
| `quitesh/src/CommandBlockBody.tsx` | `from './modeRegistry'` → `from '@quitesh/semmap'` |
| `quitesh/src/resolveBindingsForEngineMode.ts` | `from './modeRegistry'` → `from '@quitesh/semmap'` |
| `quitesh/src/buildKeybindingPreset.ts` | `from './modeRegistry'`, `from './presets/vim'`, `from './presets/emacs'` → mix of `@quitesh/semmap` + local preset adapters |
| `quitesh/src/Settings.tsx`, `paneActions.ts`, `useLayoutObserver.ts`, `PaneBody.tsx`, `blockBrowserRemaps.ts`, `KeyDebugOverlay.tsx`, `useKeyboardHandler.ts`, `AppKeyboardScope.tsx`, `KeyboardProvider.tsx`, `InputBar.tsx`, `HistorySearchKeyboardScope.tsx`, `ModalKeyboardScopes.tsx`, `CommandPaletteKeyboardScope.tsx`, `RoverKeyboardScope.tsx`, `keybindings.ts`, `PaneKeyboardScope.tsx`, `InputScope.tsx`, `BlockExpandedKeyboardScope.tsx`, `App.tsx`, `keyboard/useKeyboardConflicts.ts`, `keyboard/shellEnginePostKey.ts`, `plugins/pluginScopes.ts`, `settings/KeyboardLayoutTab.tsx`, `settings/KeybindingsTab.tsx`, `terminal/TerminalKeyboardScope.tsx`, `terminal/TerminalView.tsx`, `cm/vimNormalGuard.ts` | `from './keyboardEngine'` / `from './modeRegistry'` / `from './keyboard/keymap'` / `from './keyboard/scopeStack'` / `from './keyboard/dispatcher'` / `from './keyboard/engineKeyEvent'` / `from './layoutMap'` → `from '@quitesh/semmap'` (single barrel — see design doc for the exported surface) |
| `quitesh/src/__tests__/*.test.ts(x)` and `quitesh/src/keyboard/__tests__/*.test.ts(x)` that stay in quite-app | Same rewrite |
| `quitesh/src/__tests__/keyboardTestUtils.tsx` | Imports rewritten to `@quitesh/semmap` |

Use a single-pass `find … -exec` or `grep -rl … | xargs sed` for the bulk
rewrites; check the diff before committing.

### 5c. Replace `passToInput` / `passToTerminal` consumers in quite-app

Search quite-app for `passToInput`, `passToTerminal`, `registerPassTarget`,
`dispatchPassTarget`:

- `quitesh/src/keyboard/buildInputScopeKeymap.ts`: emits
  `{ type: 'passToInput' }`. Change to `{ type: 'passthrough' }`.
- `quitesh/src/keyboard/dispatchPassTarget.ts`: the dispatcher no longer has
  `registerPassTarget`. Replace the file's behavior with a free function (or
  inline at the App.tsx call site) that handles the `passthrough` result
  based on the active focus context. Pseudocode:

  ```ts
  // in App.tsx capture handler, replacing `if (dispatchPassTarget(...)) return`
  if (result.type === 'passthrough') {
    const active = document.activeElement
    const inTerminal =
      active instanceof Element &&
      !!active.closest('[data-focus-context="terminal-interactive"]')
    if (inTerminal) {
      // Terminal: re-dispatch to ghostty-web's synthetic-keydown entry.
      // The existing TerminalView re-dispatch helper moves here.
      reDispatchToActiveTerminal(e)
      e.preventDefault()
      e.stopPropagation()
    }
    // else: input context — fall through, let the trusted keydown reach CM.
    return
  }
  ```

  The `reDispatchToActiveTerminal` helper consolidates what was the
  `'terminal'` pass-target. It looks up the focused
  `[data-focus-context="terminal-interactive"]` ancestor's owning
  `TerminalView` (via an existing registry, e.g. `terminalSyntheticEvent.ts`)
  and dispatches the synthetic keydown there. The focus-based lookup is a
  real check, not a class-name lookup — keep parity with the existing
  `active.closest('[data-focus-context="terminal-interactive"]')` pattern
  used elsewhere in `App.tsx`.

- `quitesh/src/terminal/terminalSyntheticEvent.ts`: the pass-target
  registration is removed (`Dispatcher` no longer exposes it). Replace with a
  module-level registry the terminal can register itself in on mount.
  Concrete shape:

  ```ts
  // terminal/terminalSyntheticEvent.ts (additions)
  type TerminalReDispatch = (e: KeyboardEvent) => void
  const terminalReDispatchers = new Map<string, TerminalReDispatch>()  // key = blockId

  export function registerTerminalReDispatcher(
    blockId: string,
    fn: TerminalReDispatch,
  ): () => void {
    terminalReDispatchers.set(blockId, fn)
    return () => {
      if (terminalReDispatchers.get(blockId) === fn) {
        terminalReDispatchers.delete(blockId)
      }
    }
  }

  export function reDispatchToActiveTerminal(e: KeyboardEvent): boolean {
    const active = document.activeElement
    if (!(active instanceof Element)) return false
    const block = active.closest<HTMLElement>('[data-block-id]')
    if (!block) return false
    const fn = terminalReDispatchers.get(block.dataset.blockId!)
    if (!fn) return false
    fn(e)
    return true
  }
  ```

  `TerminalView.tsx` calls `registerTerminalReDispatcher(blockId, redispatch)`
  on mount, stores the cleanup function, calls it on unmount. The App.tsx
  capture handler imports `reDispatchToActiveTerminal` from this module and
  uses it in the `passthrough` branch shown above.

- `quitesh/src/terminal/TerminalKeyboardScope.tsx` and
  `quitesh/src/terminal/TerminalView.tsx`: same — update to the new
  registry instead of `dispatcher.registerPassTarget('terminal', …)`.

- `quitesh/src/__tests__/keyboardEngine.test.ts`: rewrite `passToInput` /
  `passToTerminal` literal strings (test fixtures) to `passthrough` — these
  duplicate the library tests but assert quite-app integration.
- `quitesh/src/keyboard/__tests__/dispatcher.test.ts`,
  `dispatchPassTarget.test.ts`,
  `buildInputScopeKeymap.test.ts`: adjust to new shapes. The
  `dispatchPassTarget.test.ts` set (the regression sentinels) is the most
  valuable; rewrite to call the new App.tsx-side handler (extracted to a
  testable function).

### 5d. Update quite-app `keybindings.ts` to use the new `Actions` constants

`keybindings.ts` references `vim.delete`, `vim.change`, `vim.yank`,
`action.universalArgument` as string literals. Keep them unchanged (defaults
match) — *or* import `Actions` from `@quitesh/semmap` and reference
`Actions.OPERATOR_DELETE` etc. The first option requires zero changes; the
second is more correct long-term. Defer to follow-up (flagged in design doc).

**Verification.**

```sh
cd /home/sauyon/devel/quite-app
pnpm install
pnpm -F quitesh typecheck
pnpm -F quitesh test     # all existing tests still pass
pnpm -F quitesh build
```

**Dependencies:** Phase 4 (library tests must be green before quite-app
relies on it).

---

## Phase 6: Verify quite-app's existing tests pass

**Rationale.** Phase 5 may have missed an import or a `passToInput`-vs-
`passthrough` literal. Phase 6 is the gate that catches it.

**Verification.**

```sh
cd /home/sauyon/devel/quite-app
pnpm -F quitesh test
pnpm -F quitesh typecheck
pnpm -F quitesh build
pnpm -F quitesh test:e2e         # required, not optional — this is a keystroke refactor
```

`test:e2e` exists in `quitesh/package.json` and is the integration check that catches anything the unit tests miss. Mandatory gate for Phase 6 — do not advance to Phase 7 with a red e2e suite.

Any regression is fixed in quite-app source — the library shouldn't need
edits at this point. If a regression *does* require a library change, loop
back to phase 3 with a patch version bump.

**Dependencies:** Phase 5.

---

## Phase 7: Initial release

**Rationale.** Once quite-app is green against the local-path package, the
library is ready to publish. The user grants npm publish access first (manual
prereq).

**Steps.**

```sh
cd /home/sauyon/devel/semmap
pnpm install
pnpm run build
pnpm run test
pnpm publish --access public
```

After publish, **before tagging**:

1. Swap quite-app's `"@quitesh/semmap": "file:../../semmap"` for
   `"@quitesh/semmap": "^0.1.0"`. Run `pnpm install`, `pnpm -F quitesh test`,
   `pnpm -F quitesh test:e2e` to confirm parity with the registry artifact.
   If the test suite passes against the local-path package but fails against
   the published one, something didn't make it into the npm tarball — fix
   `files`/`exports` in `package.json`, publish a `0.1.1`, retry. Do NOT tag
   until consumer parity is reconfirmed against the published version.
2. Once parity is confirmed, tag the release in `/home/sauyon/devel/semmap`:
   `git tag v0.1.0 && git push --tags` (only after the user creates an
   origin remote — the agent does not push by default).

**Verification.**

```sh
npm view @quitesh/semmap@0.1.0       # confirms the package landed
cd /home/sauyon/devel/quite-app
pnpm -F quitesh test               # passes against the registry artifact
pnpm -F quitesh test:e2e           # ditto
```

The release is complete only after these all return green against the
registry-installed `^0.1.0` — not just the `file:` path.

**Dependencies:** Phase 6 + manual npm-org prereq.

---

## Cross-cutting notes

- **Commit cadence.** Each phase ends in a commit (created by the user, not
  the agent — phase 1 leaves the repo with no initial commit per the task
  brief, and subsequent commits should be reviewed by the user). Squash or
  keep separate per the user's preference.
- **Compatibility window.** Quite-app is unreleased and explicitly does not
  carry backcompat (per `/home/sauyon/devel/quite-app/CLAUDE.md`). Any
  pre-extraction internal call sites are rewritten in phase 5; no shim
  modules linger.
- **Risks flagged during plan.**
  - The `Mode`/`ModeId` type carried in `modeRegistry.ts` is vestigial post-
    `KeymapSource` refactor. Keeping it for parity in this release; prune
    post-0.1.0 once consumers confirm no references. Flagged in the design
    doc.
  - `presets/emacs.ts` currently imports `DEFAULT_BINDINGS` from quite-app.
    Phase 3c cuts that — but the resulting library grammar is *narrower*
    than what quite-app expects. Quite-app's preset adapter
    (`buildKeybindingPreset.ts` + `presets/emacs.ts` local) must compose
    `DEFAULT_BINDINGS` back on top, which is its existing job. Confirm
    during phase 5 that no test asserts on a binding that lived only in the
    library copy.
  - Terminal pass-target re-dispatch behavior is well-tested today via
    `dispatchPassTarget.test.ts`. Whoever extracts the registry replacement
    in phase 5c should port the regression sentinels (especially the
    "passToInput must not preventDefault" case) into quite-app's test
    suite, repointed at the new code path.
