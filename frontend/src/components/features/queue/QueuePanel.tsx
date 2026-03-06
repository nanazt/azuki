import { useCallback } from "react";
import { ListMusic, Music, Search, Loader2 } from "lucide-react";
import { usePlayerStore } from "../../../stores/playerStore";
import { useDownloadStore, type DownloadEntry } from "../../../stores/downloadStore";
import { api } from "../../../lib/api";
import { QueueItem } from "./QueueItem";
import { useToast } from "../../../hooks/useToast";

interface QueuePanelProps {
  onOpenSearch?: () => void;
}

export function QueuePanel({ onOpenSearch }: QueuePanelProps) {
  const { showToast } = useToast();
  const playState = usePlayerStore((s) => s.playState);
  const queue = usePlayerStore((s) => s.queue);
  const downloads = useDownloadStore((s) => s.downloads);
  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.status === "downloading"
  );

  const currentTrack = playState.status !== "idle" ? playState.track : null;

  const handleRemove = useCallback(async (position: number) => {
    try {
      await api.removeFromQueue(position);
      showToast("Removed from queue", "success");
    } catch (err) {
      console.error("Failed to remove from queue", err);
      showToast("Failed to remove from queue", "error");
    }
  }, [showToast]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
        <ListMusic size={16} className="text-[var(--color-text-secondary)]" />
        <span className="text-sm font-semibold text-[var(--color-text)]">Queue</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {/* Now playing */}
        {currentTrack && (
          <div className="mb-3">
            <div className="px-4 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
                Now Playing
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg bg-[var(--color-bg-tertiary)]">
              {currentTrack.thumbnail_url ? (
                <img
                  src={currentTrack.thumbnail_url}
                  alt={currentTrack.title}
                  className="w-9 h-9 rounded object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-9 h-9 rounded bg-[var(--color-bg-hover)] flex items-center justify-center flex-shrink-0">
                  <Music size={14} className="text-[var(--color-text-tertiary)]" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--color-text)] truncate">
                  {currentTrack.title}
                </div>
                {currentTrack.artist && (
                  <div className="text-xs text-[var(--color-text-secondary)] truncate">
                    {currentTrack.artist}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Downloading */}
        {activeDownloads.length > 0 && (
          <div className="mb-3">
            <div className="px-4 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                Downloading
              </span>
            </div>
            <div className="px-3 space-y-1">
              {activeDownloads.map((dl) => (
                <DownloadItem key={dl.download_id} download={dl} />
              ))}
            </div>
          </div>
        )}

        {/* Up next */}
        {queue.length > 0 ? (
          <div>
            <div className="px-4 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                Up Next
              </span>
            </div>
            <div className="px-1">
              {queue.map((entry, index) => (
                <QueueItem
                  key={`${entry.track.id}-${index}`}
                  entry={entry}
                  position={index + 1}
                  onRemove={handleRemove}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <ListMusic size={32} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">Queue is empty</p>
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className="flex items-center gap-1.5 text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors cursor-pointer"
              >
                <Search size={12} />
                Search for music
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DownloadItem({ download }: { download: DownloadEntry }) {
  const percent = Math.round(download.percent);
  const speed = download.speed_bps
    ? `${(download.speed_bps / 1024 / 1024).toFixed(1)} MB/s`
    : null;

  return (
    <div className="flex items-center gap-3 py-2 px-1 rounded-lg">
      <div className="w-9 h-9 rounded bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
        <Loader2 size={14} className="text-[var(--color-accent)] animate-spin" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--color-text)] truncate font-medium">
          {download.query}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 h-1.5 rounded-full bg-[var(--color-bg-tertiary)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-[10px] text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">
            {percent}%{speed && ` · ${speed}`}
          </span>
        </div>
      </div>
    </div>
  );
}
