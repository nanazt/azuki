import { useEffect, useState } from "react";
import clsx from "clsx";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { Heart, Plus, Loader2 } from "lucide-react";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";
import { useToast } from "../components/ui/Toast";
import { formatTime } from "../lib/utils";

export function Favorites() {
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .getFavorites()
      .then((res) => setTracks(res.tracks))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { track_id, favorited } = (e as CustomEvent).detail;
      if (!favorited) {
        setTracks((prev) => prev.filter((t) => t.id !== track_id));
      } else {
        // Re-fetch to get the full track info for the newly favorited track
        api.getFavorites().then((res) => setTracks(res.tracks)).catch(() => {});
      }
    };
    window.addEventListener("favorite-changed", handler);
    return () => window.removeEventListener("favorite-changed", handler);
  }, []);

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

  const handleUnfavorite = async (track: TrackInfo) => {
    if (togglingIds.has(track.id)) return;
    setTogglingIds((prev) => new Set(prev).add(track.id));
    setExitingIds((prev) => new Set(prev).add(track.id));
    try {
      await api.toggleFavorite(track.id);
      setTimeout(() => {
        setTracks((prev) => prev.filter((t) => t.id !== track.id));
        setExitingIds((prev) => {
          const next = new Set(prev);
          next.delete(track.id);
          return next;
        });
      }, 200);
    } catch {
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <h1 className="text-xl font-bold text-[var(--color-text)]">Favorites</h1>

      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
              <div className="flex-1 flex flex-col gap-1.5">
                <Skeleton className="h-4 w-2/3 rounded" />
                <Skeleton className="h-3 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : tracks.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Heart size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">No favorites yet.</p>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            Heart a track to save it here.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {tracks.map((track) => (
            <li
              key={track.id}
              className={clsx(
                "flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-[var(--color-bg-secondary)] transition-all duration-200 group",
                exitingIds.has(track.id) && "opacity-0 scale-95"
              )}
            >
              <TrackThumbnail track={track} sizeClass="w-12 h-12" iconSize={20} className="rounded-lg" />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--color-text)] truncate">{track.title}</p>
                {track.artist && (
                  <p className="text-xs text-[var(--color-text-tertiary)] truncate">{track.artist}</p>
                )}
              </div>

              {/* Duration */}
              <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
                {formatTime(track.duration_ms)}
              </span>

              {/* Actions */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => handleAdd(track)}
                  disabled={addingIds.has(track.id)}
                  className="p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors disabled:opacity-50"
                  aria-label="Add to queue"
                >
                  {addingIds.has(track.id) ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                </button>
                <button
                  onClick={() => handleUnfavorite(track)}
                  disabled={togglingIds.has(track.id)}
                  className="p-1.5 rounded-lg text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors disabled:opacity-50"
                  aria-label="Remove from favorites"
                >
                  <Heart size={15} fill="currentColor" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
