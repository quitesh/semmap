import type { EngineResult } from '../keyboardEngine.js'

const ENGINE_KEY = '__quiteshEngineKeyResult'

type WithEngineCache = KeyboardEvent & {
  [ENGINE_KEY]?: EngineResult
}

/** Attach {@link EngineResult} from the first `processKey` pass (e.g. InputBar) for App reuse. */
export function setEngineKeyResult(e: KeyboardEvent, result: EngineResult): void {
  ;(e as WithEngineCache)[ENGINE_KEY] = result
}

/** Read cached engine result so `processKey` is not invoked twice for the same physical key. */
export function getEngineKeyResult(e: KeyboardEvent): EngineResult | undefined {
  return (e as WithEngineCache)[ENGINE_KEY]
}
