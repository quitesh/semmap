// ── Values ──────────────────────────────────────────────────────────
export { KeyboardEngine, Actions } from './keyboardEngine.js'
export { ScopeStack } from './keyboard/scopeStack.js'
export { Dispatcher } from './keyboard/dispatcher.js'
export { normalizeKeyEvent, resolveBaseKey } from './modeRegistry.js'
export { setEngineKeyResult, getEngineKeyResult } from './keyboard/engineKeyEvent.js'
export { defineSemanticActionRemaps, isSemanticActionId } from './keyboard/keymap.js'
export {
  observeKey,
  resolveCode,
  getLayoutMap,
  setLayoutMap,
  subscribeLayoutMap,
  addLayoutSource,
  QWERTY_MAP,
} from './layoutMap.js'

// ── Types ───────────────────────────────────────────────────────────
export type {
  EngineResult,
  EngineState,
  KeymapSource,
  KeymapConflict,
} from './keyboardEngine.js'

export type { KeyEvent, Mode, ModeId } from './modeRegistry.js'

export type {
  BindingEntry,
  Keymap,
  KeyStr,
  ActionId,
  KeymapActionId,
  HandlerActionId,
  ActionRemap,
  SemanticActionId,
  SemanticActionRemaps,
} from './keyboard/keymap.js'

export type {
  Scope,
  ActionArgs,
  HandlerFn,
} from './keyboard/scopeStack.js'

export type { EngineResultLike } from './keyboard/dispatcher.js'

export type { LayoutMap, LayoutSource } from './layoutMap.js'
