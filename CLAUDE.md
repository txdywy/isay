# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

iSay is a P2P real-time voice chat PWA built on WebRTC via PeerJS. No registration — users share a link or QR code to join a room. Up to 8 participants in a mesh network. Deployed as static files to GitHub Pages (no build step).

## Commands

```bash
npm test              # Run all tests (Vitest, jsdom, globals enabled)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report (V8 provider)
npx vitest run tests/utils.test.js         # Run a single test file
npx vitest run -t "token generation"       # Run tests matching a name
npm run lint          # ESLint on js/**/*.js
npm run lint:fix      # Auto-fix lint issues
npm run dev           # npx serve . (local dev server)
```

## Architecture

**No build step.** Pure ES modules served directly. PeerJS 1.5.4 and QRCode.js loaded via CDN in `index.html`. Static deployment — GitHub Actions uploads the repo root as-is.

**Entry point:** `js/main.js` imports all modules and orchestrates the app lifecycle (join room, end call, restart, event binding, QR generation, wake lock).

**Module layout (`js/`):**

| Layer | Modules | Role |
|-------|---------|------|
| Core | `config.js`, `state.js` | Centralized constants/feature-flags; singleton state manager with event emitter (`peer:add`, `peer:remove`, `reconnect:needed`, `audio:trackended`) |
| Peer | `peer/connection.js`, `peer/mesh.js`, `peer/network.js` | PeerJS lifecycle, host/guest slot negotiation, mesh scanning, ICE restart, network migration |
| Audio | `audio/stream.js`, `audio/visualizer.js`, `audio/qos.js` | getUserMedia, mute/speaker, adaptive bitrate/jitter buffer; canvas frequency visualization; RTCStats-based quality scoring |
| UI | `ui/screens.js`, `ui/toast.js`, `ui/chat.js` | 4-screen manager (landing/waiting/call/disconnected); toast notifications; text chat over PeerJS DataConnection with ping/pong |
| Utils | `utils/helpers.js` | Cached `$()` DOM selector, leveled logger with `child(prefix)`, token generation/sanitization, clipboard, haptics, compatibility checks |

**Key patterns:**
- **Singleton exports:** `state`, `screens`, `chat`, `toast` each export a pre-instantiated class instance.
- **Event-driven decoupling:** State emits events; modules subscribe rather than importing each other directly.
- **Callback injection:** `connectPeer()` and mesh functions accept callback objects (`onPeerConnected`, `onAllPeersDisconnected`, `onPhaseChange`) from `main.js` to avoid circular imports.
- **Dual export:** Each module provides both named exports and a default object wrapping them.
- **DOM cache:** `$()` in `helpers.js` caches querySelector results in a Map; use `clearDomCache()` after DOM mutations that add/remove cached elements.

**PeerJS ID scheme:** `isay-{token}-host` for the room host, `isay-{token}-g{0..7}` for guests. Functions in `config.js` (`formatPeerId`, `parsePeerId`) handle encoding/decoding.

**Room flow:** Landing → enter room name → `connectPeer()` tries host slot first; if taken (`unavailable-id`), falls through to `becomeGuest()` which iterates guest slots → mesh scan discovers other peers → calls are initiated/answered → QoS monitoring runs during call.

**Legacy file:** `app.js` is the original monolithic IIFE (~1743 lines). `index.html` loads `js/main.js` (the modular version). `app.js` is retained for reference only.

## Testing

- **Framework:** Vitest with jsdom environment and global APIs (`describe`, `it`, `expect`, `vi`).
- **Existing tests cover:** `config`, `state`, `utils`, `toast`, `screens`, `chat`. Modules in `peer/` and `audio/` lack unit tests (they depend heavily on WebRTC/PeerJS APIs).
- **Test style:** Tests import the module directly, use `vi.useFakeTimers()` where needed, and mock DOM with jsdom's built-in DOM. `beforeEach` resets state via `state.reset()` or `clearDomCache()`.
- **No mocking of PeerJS or WebRTC APIs** in existing tests — tests focus on pure logic, config validation, and UI state management.

## Conventions

- `no-var`, `prefer-const`, `eqeqeq` enforced by ESLint.
- Logger usage: `import { logger } from './helpers.js'` then `const log = logger.child('ModuleName')` — levels are DEBUG/INFO/WARN/ERROR/SILENT. Production defaults to WARN.
- All timeouts/timers managed through `state.setTimer(id, fn, delay, interval)` / `state.clearTimer(id)` — never raw `setTimeout`/`setInterval` in modules (enables clean teardown).
- iOS/Safari compatibility is a primary concern — `config.BROWSER.isSafari` / `config.BROWSER.isIOS` gates platform-specific paths (audio session config, stream recovery, autoplay unlock).
- CSS class toggling drives screen visibility — `screens.show('call')` adds `.active` to `#screen-call` and removes it from others.
