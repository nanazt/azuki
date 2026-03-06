<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-06 | Updated: 2026-03-06 -->

# azuki-media

## Purpose
Media services: yt-dlp subprocess wrapper for YouTube downloads, file-based media store with cache management, file upload handling, and lrclib lyrics fetching.

## Key Files

| File | Description |
|------|-------------|
| `Cargo.toml` | Media dependencies (reqwest, tokio, sha2) |
| `src/lib.rs` | Re-exports: `MediaStore`, `YtDlp`, `LyricsService` |
| `src/ytdlp.rs` | yt-dlp subprocess wrapper for audio extraction |
| `src/store.rs` | File-based media store with size-limited cache cleanup |
| `src/upload.rs` | File upload handling |
| `src/lyrics.rs` | lrclib.net lyrics fetcher (synced + plain) |

## For AI Agents

### Working In This Directory
- `YtDlp` doesn't impl Clone — always wrap in `Arc<YtDlp>`
- `MediaStore::new(dir, max_gb)` creates media directory if needed
- Cache cleanup runs hourly from main.rs via `cleanup_cache()`
- Requires `yt-dlp` binary on PATH for YouTube downloads

<!-- MANUAL: -->
