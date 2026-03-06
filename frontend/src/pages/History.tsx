import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { Button } from "../components/ui/Button";
import { Music, Clock } from "lucide-react";
import { formatTime } from "../lib/utils";

interface HistoryEntry {
  track: TrackInfo;
  played_at: string;
  user_id: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
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
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNewTrack, setHasNewTrack] = useState(false);

  const PER_PAGE = 20;

  const loadPage = async (p: number, append = false) => {
    if (p === 1) setLoading(true);
    else setLoadingMore(true);

    try {
      const res = await api.getHistory(p, PER_PAGE);
      setTotal(res.total);
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    loadPage(1);
  }, []);

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    loadPage(next, true);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (page === 1 && window.scrollY < 50) {
        setItems((prev) => [{
          track: detail.track,
          played_at: new Date().toISOString(),
          user_id: detail.user_id,
        }, ...prev]);
        setTotal((t) => t + 1);
      } else {
        setHasNewTrack(true);
      }
    };
    window.addEventListener("history-added", handler);
    return () => window.removeEventListener("history-added", handler);
  }, [page]);

  const handlePlay = (track: TrackInfo) => {
    api.addToQueue(track.source_url).catch(() => {});
  };

  const hasMore = items.length < total;

  return (
    <div className="p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">History</h1>
        {total > 0 && (
          <span className="text-sm text-[var(--color-text-tertiary)]">
            {total} track{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="w-10 h-10 rounded-md flex-shrink-0" />
              <div className="flex-1 flex flex-col gap-1.5">
                <Skeleton className="h-4 w-2/3 rounded" />
                <Skeleton className="h-3 w-1/3 rounded" />
              </div>
              <Skeleton className="h-3 w-12 rounded" />
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
              onClick={() => {
                setHasNewTrack(false);
                setPage(1);
                loadPage(1);
              }}
              className="w-full py-2 text-sm text-[var(--color-accent)] bg-[var(--color-accent)]/10 rounded-lg hover:bg-[var(--color-accent)]/20 transition-colors"
            >
              New track played — click to refresh
            </button>
          )}
          <ul className="flex flex-col gap-1">
            {items.map((entry, i) => (
              <li key={i}>
                <button
                  onClick={() => handlePlay(entry.track)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors text-left group"
                >
                  {entry.track.thumbnail_url ? (
                    <img
                      src={entry.track.thumbnail_url}
                      alt={entry.track.title}
                      className="w-10 h-10 rounded-md object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-[var(--color-bg-secondary)] flex items-center justify-center flex-shrink-0">
                      <Music size={16} className="text-[var(--color-text-tertiary)]" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">
                      {entry.track.title}
                    </p>
                    {entry.track.artist && (
                      <p className="text-xs text-[var(--color-text-tertiary)] truncate">
                        {entry.track.artist}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {formatDate(entry.played_at)}
                    </span>
                    <span className="text-xs text-[var(--color-text-tertiary)]">
                      {formatTime(entry.track.duration_ms)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="ghost" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
