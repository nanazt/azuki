<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki-player

## Purpose
Playback engine using actor pattern. Manages play queue (VecDeque with loop modes), playback state machine, and WebSocket event broadcasting.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Player dependencies |
| `src/lib.rs` | Re-exports: `PlayerController` |
| `src/controller.rs` | Actor-pattern controller with mpsc command channel, playback state machine |
| `src/queue.rs` | VecDeque-based queue with loop modes (none, track, queue) |
| `src/events.rs` | WebSocket wire protocol event types for real-time sync |

## For AI Agents

### Working In This Directory
- `PlayerController` communicates via mpsc commands — never hold locks across awaits
- Queue supports loop modes: None, Track, Queue
- Events are broadcast to all connected WebSocket clients via the hub
- State changes must emit corresponding WebSocket events

<!-- MANUAL: -->
