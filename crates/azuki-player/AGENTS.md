<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-10 -->

# azuki-player

## Purpose
Playback engine using actor pattern. Manages play queue (VecDeque with loop modes), playback state machine, and WebSocket event broadcasting.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Player dependencies |
| `src/lib.rs` | Re-exports: `PlayerController` |
| `src/controller.rs` | PlayerController public API — mpsc command sender, handle creation |
| `src/actor.rs` | Actor loop — receives commands, manages playback state machine |
| `src/queue.rs` | VecDeque-based queue with loop modes (None, One, All) |
| `src/events.rs` | WebSocket wire protocol event types for real-time sync |
| `src/controller_tests.rs` | Unit tests for controller/actor logic |
| `src/queue_tests.rs` | Unit tests for queue operations and loop modes |

## For AI Agents

### Working In This Directory
- `PlayerController` communicates via mpsc commands — never hold locks across awaits
- `controller.rs` is the public-facing handle; `actor.rs` is the internal actor loop (separated for clarity)
- Queue supports loop modes: None, One, All
- Events are broadcast to all connected WebSocket clients via the hub
- State changes must emit corresponding WebSocket events

<!-- MANUAL: -->
