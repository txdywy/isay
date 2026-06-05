# iSay — Decentralized Voice for Everyone

> **Zero servers. Zero sign-ups. Pure peer-to-peer voice.**

iSay is an open-source, browser-native voice chat platform that eliminates the middleman. Built entirely on WebRTC with a self-organizing mesh topology, iSay lets anyone spin up a private voice room in seconds — no downloads, no accounts, no data harvesting. Just share a link and talk.

We believe real-time communication infrastructure should be owned by the people who use it, not rented from corporations. iSay is our proof that it's possible — today, in the browser, with zero backend.

---

## Why iSay

Traditional voice platforms route every syllable through centralized servers. This creates latency bottlenecks, single points of failure, surveillance surfaces, and vendor lock-in. iSay takes a fundamentally different approach:

- **True P2P** — Audio streams flow directly between peers via WebRTC. No relay server, no SFU, no middle box.
- **Zero Infrastructure** — Deployed as static files on GitHub Pages. The signaling layer is PeerJS's public cloud; everything else is peer-to-peer.
- **Zero Friction** — No registration, no downloads, no plugins. One link. One click. You're talking.
- **Privacy by Architecture** — When there's no server in the middle, there's nothing to subpoena, nothing to breach, nothing to monetize.

---

## Features

| Category | Capabilities |
|----------|-------------|
| **Voice** | Full-duplex P2P audio, echo cancellation, noise suppression, automatic gain control, adaptive bitrate (16–64 kbps) |
| **Mesh Network** | Up to 8 participants in a self-healing mesh with automatic peer discovery, slot negotiation, and exponential-backoff reconnection |
| **Resilience** | ICE restart on network change, connection state monitoring with graduated recovery (restart → reconnect → full reset), Safari/iOS stream recovery |
| **Quality** | Real-time QoS dashboard — latency, jitter, packet loss, 5-point quality score, glitch detection via concealed sample analysis |
| **Chat** | In-call text messaging over PeerJS DataConnection with ping/pong latency measurement |
| **Visualization** | Canvas-based real-time frequency bar visualization with speaking detection (RMS energy analysis) |
| **Accessibility** | ARIA live announcements, screen reader support, keyboard navigation, `prefers-reduced-motion` respect |
| **Mobile** | iOS/Safari-optimized with audioSession API, autoplay unlock, background/foreground recovery, wake lock |
| **PWA** | Installable, offline-capable via service worker (network-first for same-origin, cache-first for CDN assets) |
| **Sharing** | QR code generation for instant room sharing, one-tap link copy |

---

## Architecture

iSay is built as a zero-dependency, zero-build-step ES module application. Every JavaScript file is served directly to the browser — no bundler, no transpiler, no `node_modules` in production.

```
┌─────────────────────────────────────────────────────────────┐
│                      js/main.js                             │
│                   (Orchestrator)                             │
│  joinRoom · endCall · restart · bindEvents · QR · WakeLock  │
└────────┬────────┬────────┬────────┬────────┬────────────────┘
         │        │        │        │        │
    ┌────▼──┐ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼────┐
    │ peer/ │ │audio/│ │ ui/  │ │config│ │ state │
    │       │ │      │ │      │ │      │ │       │
    │connec-│ │stream│ │screen│ │NET   │ │Event  │
    │tion   │ │viz   │ │toast │ │AUDIO │ │emit   │
    │mesh   │ │qos   │ │chat  │ │QOS   │ │Timers │
    │network│ │      │ │      │ │PEERID│ │Peers  │
    └───────┘ └──────┘ └──────┘ └──────┘ └───────┘
                                         ┌───────┐
                                         │helpers│
                                         │ $()   │
                                         │logger │
                                         │token  │
                                         └───────┘
```

### Design Principles

1. **Event-Driven Decoupling** — Modules communicate through `state.emit()` / `state.on()`, never through direct imports of unrelated modules. This keeps the dependency graph acyclic and each module independently testable.

2. **Callback Injection for Circular Avoidance** — The peer layer receives callback objects (`onPeerConnected`, `onAllPeersDisconnected`, `onPhaseChange`) from the orchestrator rather than importing it, cleanly breaking what would otherwise be circular dependencies.

3. **Centralized Timer Management** — All `setTimeout`/`setInterval` calls go through `state.setTimer(id, fn, delay, interval)`, enabling deterministic cleanup on call teardown. No orphaned timers.

4. **Progressive Enhancement** — Core functionality works on any WebRTC-capable browser. iOS/Safari quirks (audioSession API, stream recovery, autoplay unlock) are gated behind feature detection, never behind user-agent sniffing.

5. **Observable State** — The `StateManager` singleton is the single source of truth. Peer connections, data channels, audio contexts, and QoS data are all tracked centrally and accessible to any module.

---

## Getting Started

### Prerequisites

- A modern browser with WebRTC support (Chrome 80+, Firefox 75+, Edge 80+, Safari 15+, iOS Safari 15+)
- HTTPS connection (required for `getUserMedia` — `npm run dev` handles this locally)

### Quick Start

```bash
git clone https://github.com/your-username/isay.git
cd isay
npm install
npm run dev        # → http://localhost:3000
```

Open the URL in two browser tabs, enter the same room name, and you're talking.

### Commands

```bash
npm test                   # Run all tests (Vitest, jsdom)
npm run test:watch         # Watch mode
npm run test:coverage      # Coverage report (V8 provider)
npx vitest run tests/utils.test.js       # Single test file
npx vitest run -t "token generation"     # Filter by test name
npm run lint               # ESLint check
npm run lint:fix           # ESLint auto-fix
```

---

## Module Reference

| Module | Lines | Responsibility |
|--------|------:|---------------|
| `js/main.js` | 393 | App lifecycle orchestrator — room join/leave, event wiring, QR generation, wake lock, UI callbacks |
| `js/config.js` | 223 | All tunable constants — network limits, ICE servers, audio constraints, bitrate tiers, QoS thresholds, UI timings, word lists |
| `js/state.js` | 298 | Singleton state manager — event emitter, named timer registry, peer/data-connection tracking, audio context management, visualization buffers |
| `js/peer/connection.js` | 257 | PeerJS lifecycle — host/guest slot negotiation with automatic fallback, 12s connection timeout, abort support |
| `js/peer/mesh.js` | 486 | Mesh network core — call initiation/answering with Safari recovery, periodic room scanning, exponential-backoff reconnection |
| `js/peer/network.js` | 155 | Network resilience — `navigator.connection` monitoring, ICE restart with 10s cooldown, per-peer connection state machine |
| `js/audio/stream.js` | 320 | Audio pipeline — getUserMedia, mute/speaker toggle, iOS audioSession config, adaptive bitrate, jitter buffer tuning |
| `js/audio/visualizer.js` | 222 | Real-time canvas visualization — frequency bars (local up/blue, remote down/green), RMS-based speaking detection |
| `js/audio/qos.js` | 232 | Quality monitoring — 2s stats polling via `RTCPeerConnection.getStats()`, 5-point scoring, glitch detection |
| `js/ui/screens.js` | 249 | Screen manager — 4 views (landing/waiting/call/disconnected), phase indicator, metrics display, accessibility state |
| `js/ui/toast.js` | 73 | Toast notifications — CSS transition animation, auto-dismiss, container management |
| `js/ui/chat.js` | 221 | Text chat — PeerJS DataConnection message protocol (chat/ping/pong), DOM rendering, auto-scroll |
| `js/utils/helpers.js` | 346 | Utilities — cached `$()` DOM selector, leveled logger with `child(prefix)`, token generation, clipboard, compatibility checks |

---

## Testing Strategy

Tests focus on **pure logic and state management** — modules that can be meaningfully tested without real WebRTC infrastructure.

| Test File | Coverage |
|-----------|----------|
| `config.test.js` | Constraint validation, threshold ordering, ID format/parse, word lists, error message structure |
| `state.test.js` | Event system (register/emit/unsubscribe/error isolation), timer lifecycle, peer tracking, state reset |
| `utils.test.js` | Token generation/sanitization, duration formatting, debounce/throttle behavior |
| `toast.test.js` | Container creation, element lifecycle, animation timing, multi-toast stacking |
| `screens.test.js` | Screen switching, active-class isolation, invalid screen handling |
| `chat.test.js` | Message rendering, broadcast logic, empty-input rejection, pong handling |

Modules in `peer/` and `audio/` depend on browser-native WebRTC APIs and PeerJS — these are validated through integration testing and real-device QA.

---

## Deployment

iSay deploys automatically to GitHub Pages on every push to `main`. The deployment pipeline is intentionally minimal:

```
Push to main → GitHub Actions → Upload repo root → GitHub Pages
```

No build step. No artifact transformation. The repository _is_ the deployment artifact.

---

## Browser Support

| Browser | Minimum Version | Notes |
|---------|----------------|-------|
| Chrome | 80+ | Full support |
| Firefox | 75+ | Full support |
| Edge | 80+ | Full support |
| Safari | 15+ | AudioSession API, stream recovery workarounds |
| iOS Safari | 15+ | Autoplay unlock, background/foreground recovery |

---

## Roadmap

iSay is just getting started. Our vision extends far beyond a two-party voice call:

- **Selective Forwarding Unit (SFU) mode** — For rooms exceeding 8 participants, with automatic mesh ↔ SFU switching
- **End-to-end encryption** — Insertable Streams API for per-frame encryption without trusting any relay
- **Screen sharing** — WebRTC `getDisplayMedia` integration with adaptive bitrate for video tracks
- **Recording** — Client-side `MediaRecorder` with IndexedDB storage and export
- **TURN server integration** — Optional self-hosted TURN for corporate/firewall-restricted environments
- **Spatial audio** — WebAudio spatialization for immersive multi-party conversations
- **Push notifications** — Web Push API for incoming call alerts when the app is backgrounded
- **Multi-language UI** — i18n support beyond the current Chinese locale

---

## Contributing

We welcome contributions of all kinds — bug reports, feature requests, documentation, and code.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please run `npm run lint` and `npm test` before submitting.

---

## License

MIT License — use it, fork it, ship it. We believe communication infrastructure should be free and open.

---

## Acknowledgments

- [PeerJS](https://peerjs.com/) — The WebRTC abstraction layer that makes browser P2P accessible
- [WebRTC](https://webrtc.org/) — The open standard that makes all of this possible

---

<p align="center">
  <strong>iSay</strong> — Because your voice shouldn't pass through someone else's server.<br>
  <em>Decentralized. Private. Free.</em>
</p>
