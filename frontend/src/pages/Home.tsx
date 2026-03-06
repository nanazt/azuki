import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { usePlayerStore } from "../stores/playerStore";
import { formatTime } from "../lib/utils";
import { Skeleton } from "../components/ui/Skeleton";
import { Music, Radio } from "lucide-react";

interface HistoryEntry {
  track: TrackInfo;
  played_at: string;
  user_id: string;
}

export function Home() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const playState = usePlayerStore((s) => s.playState);

  const currentTrack = playState.status !== "idle" ? playState.track : null;

  useEffect(() => {
    api
      .getHistory(1, 10)
      .then((res) => setHistory(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handlePlay = (track: TrackInfo) => {
    api.addToQueue(track.source_url).catch(() => {});
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-8">
      {/* Now Playing banner */}
      {currentTrack ? (
        <div className="flex items-center gap-4 p-4 rounded-xl bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30">
          {currentTrack.thumbnail_url ? (
            <img
              src={currentTrack.thumbnail_url}
              alt={currentTrack.title}
              className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-14 h-14 rounded-lg bg-[var(--color-bg-secondary)] flex items-center justify-center flex-shrink-0">
              <Music size={24} className="text-[var(--color-text-tertiary)]" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs text-[var(--color-accent)] font-semibold uppercase tracking-wide mb-0.5 flex items-center gap-1.5">
              <Radio size={12} />
              Now Playing
            </p>
            <p className="text-[var(--color-text)] font-semibold truncate">{currentTrack.title}</p>
            {currentTrack.artist && (
              <p className="text-sm text-[var(--color-text-secondary)] truncate">{currentTrack.artist}</p>
            )}
          </div>
          <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
            {formatTime(currentTrack.duration_ms)}
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
          <div className="w-12 h-12 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center">
            <Music size={24} className="text-[var(--color-accent)]" />
          </div>
          <div>
            <p className="font-semibold text-[var(--color-text)]">Nothing playing right now</p>
            <p className="text-sm text-[var(--color-text-tertiary)] mt-1">
              Search for a track or pick from your history below.
            </p>
          </div>
        </div>
      )}

      {/* Recently Played */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--color-text)] mb-4">Recently Played</h2>
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 rounded-md flex-shrink-0" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-2/3 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-[var(--color-text-tertiary)]">No history yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.map((entry, i) => (
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
                  <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
                    {formatTime(entry.track.duration_ms)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
