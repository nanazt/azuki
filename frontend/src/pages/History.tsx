import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";
import { Clock, Plus, Loader2 } from "lucide-react";
import { formatTime } from "../lib/utils";
import { useToast } from "../components/ui/Toast";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import clsx from "clsx";

interface HistoryEntry {
  track: TrackInfo;
  played_at: string;
  user_id: string;
  play_count: number;
}

function formatDate(iso: string): string {
  const date = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function History() {
  const [hasNewTrack, setHasNewTrack] = useState(false);
  const [isFirstPage, setIsFirstPage] = useState(true);

  const { items, setItems, loading, loadingMore, hasMore, sentinelRef, reload, loadMore } =
    useInfiniteScroll<HistoryEntry>({
      fetcher: (cursor) => api.getHistory(cursor),
    });

  // Track when user scrolls past first page
  const handleReload = useCallback(() => {
    setHasNewTrack(false);
    setIsFirstPage(true);
    reload();
  }, [reload]);

  useEffect(() => {
    if (loadingMore) setIsFirstPage(false);
  }, [loadingMore]);

  // Real-time track insertion
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const scrollTop = document.querySelector("[data-main-scroll]")?.scrollTop ?? 0;
      if (isFirstPage && scrollTop < 50) {
        setItems((prev) => {
          const existing = prev.find((entry) => entry.track.id === detail.track.id);
          const filtered = prev.filter((entry) => entry.track.id !== detail.track.id);
          return [{
            track: detail.track,
            played_at: new Date().toISOString(),
            user_id: detail.user_id,
            play_count: (existing?.play_count ?? 0) + 1,
          }, ...filtered];
        });
      } else {
        setHasNewTrack(true);
      }
    };
    window.addEventListener("history-added", handler);
    return () => window.removeEventListener("history-added", handler);
  }, [isFirstPage, setItems]);

  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const { showToast } = useToast();

  const handleAdd = async (track: TrackInfo) => {
    if (addingIds.has(track.id)) return;
    setAddingIds(prev => new Set(prev).add(track.id));
    try {
      await api.addToQueue(track.source_url);
    } catch {
      showToast("Failed to add to queue", "error");
    } finally {
      setAddingIds(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">History</h1>
      </div>

      {loading ? (
        <div className="flex flex-col">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2">
              <Skeleton className="w-12 h-12 rounded flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-3/4 rounded" />
                <Skeleton className="h-3 w-1/2 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Clock size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">No play history yet.</p>
          <p className="text-sm text-[var(--color-text-tertiary)]">Start listening!</p>
        </div>
      ) : (
        <>
          {hasNewTrack && (
            <button
              onClick={handleReload}
              className="w-full py-2 text-sm text-[var(--color-text)] bg-[var(--color-accent)]/10 rounded-lg hover:bg-[var(--color-accent)]/20 transition-colors"
            >
              New track played — click to refresh
            </button>
          )}
          <ul className="flex flex-col">
            {items.map((entry) => (
              <li key={`${entry.track.id}-${entry.played_at}`} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group">
                  <TrackThumbnail track={entry.track} sizeClass="w-12 h-12" iconSize={18} className="rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--color-text)] truncate">
                      {entry.track.title}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] truncate">
                      {entry.track.artist ?? "Unknown artist"}
                      <span className="text-[var(--color-text-tertiary)] ml-2">
                        {formatDate(entry.played_at)}
                      </span>
                      {entry.track.duration_ms > 0 && (
                        <span className="text-[var(--color-text-tertiary)] ml-1">
                          · {formatTime(entry.track.duration_ms)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAdd(entry.track)}
                    disabled={addingIds.has(entry.track.id)}
                    className={clsx(
                      "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium",
                      "transition-all duration-150 cursor-pointer",
                      addingIds.has(entry.track.id)
                        ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] cursor-not-allowed"
                        : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[#1a1a1a] opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    )}
                    aria-label={`Add ${entry.track.title} to queue`}
                  >
                    {addingIds.has(entry.track.id)
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Plus size={12} />}
                    {addingIds.has(entry.track.id) ? "Adding…" : "Add"}
                  </button>
              </li>
            ))}
          </ul>

          {/* Sentinel + skeleton loading */}
          {hasMore && (
            <div ref={sentinelRef}>
              {loadingMore ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <div className="w-12 h-12 rounded bg-[var(--color-bg-tertiary)] animate-pulse flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-[var(--color-bg-tertiary)] rounded animate-pulse w-3/4" />
                      <div className="h-3 bg-[var(--color-bg-tertiary)] rounded animate-pulse w-1/2" />
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-8" />
              )}
            </div>
          )}

          {/* Keyboard fallback */}
          {hasMore && !loadingMore && (
            <button
              onClick={loadMore}
              className="sr-only focus:not-sr-only focus:flex focus:justify-center focus:py-3 focus:text-sm focus:text-[var(--color-text-secondary)] focus:underline w-full"
            >
              Load more
            </button>
          )}

          {/* End-of-list indicator */}
          {!loading && !hasMore && items.length > 0 && (
            <div className="flex items-center gap-3 px-3 py-6">
              <div className="flex-1 h-px bg-[var(--color-border)]" />
              <span className="text-xs text-[var(--color-text-tertiary)] px-2 shrink-0">
                {items.length} tracks
              </span>
              <div className="flex-1 h-px bg-[var(--color-border)]" />
            </div>
          )}

          {/* Screen reader announcement */}
          <div aria-live="polite" aria-atomic="false" className="sr-only">
            {loadingMore ? "Loading more tracks" : ""}
            {!hasMore && items.length > 0 ? `All ${items.length} tracks loaded` : ""}
          </div>
        </>
      )}
    </div>
  );
}
