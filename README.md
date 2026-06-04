# @quitesh/semmap

Semantic keystroke routing engine: keymap → semantic action → per-scope remap → handler.

`semmap` (SEMantic MAPping engine) is a pure-TypeScript library for layered,
scope-aware keystroke routing with vim/emacs grammar built in. It is a routing
core — not a UI framework. React glue, focus management, action catalogs, YAML
config, and per-app dispatch policy are all consumer concerns.

## Install

```sh
pnpm add @quitesh/semmap
```

## Minimal usage

```ts
import { KeyboardEngine, ScopeStack, Dispatcher } from '@quitesh/semmap'
import { vimGrammar } from '@quitesh/semmap/presets/vim'

const stack = new ScopeStack()
stack.pushOrUpdate({
  id: 'editor',
  keymap: vimGrammar().normal,
  acceptsLeadingCount: true,
})

const engine = new KeyboardEngine(stack)
const dispatcher = new Dispatcher(stack)

window.addEventListener('keydown', (e) => {
  const result = engine.processKey(e)
  if (dispatcher.dispatch(result, e)) e.preventDefault()
})
```

See `docs/superpowers/specs/2026-05-28-semmap-design.md` for the full API surface.
