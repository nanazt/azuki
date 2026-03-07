import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { UserStats, ServerStats, TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { formatTime } from "../lib/utils";
import { BarChart2 } from "lucide-react";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";

function TrackRow({ track, count, rank }: { track: TrackInfo; count: number; rank: number }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-[var(--color-text-tertiary)] w-5 text-right flex-shrink-0">
        {rank}
      </span>
      <TrackThumbnail track={track} sizeClass="w-9 h-9" iconSize={14} className="rounded-md" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--color-text)] truncate">{track.title}</p>
        {track.artist && (
          <p className="text-xs text-[var(--color-text-tertiary)] truncate">{track.artist}</p>
        )}
      </div>
      <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
        {count} play{count !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

function HourlyChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);

  return (
    <div className="overflow-x-auto">
    <div className="flex items-end gap-1 h-20 min-w-[320px]">
      {data.map((count, hour) => {
        const heightPct = (count / max) * 100;
        return (
          <div
            key={hour}
            className="flex-1 flex flex-col items-center gap-1 group"
            title={`${hour}:00 — ${count} plays`}
          >
            <div
              className="w-full rounded-sm bg-[var(--color-accent)]/60 group-hover:bg-[var(--color-accent)] transition-colors"
              style={{ height: `${Math.max(heightPct, 2)}%` }}
            />
          </div>
        );
      })}
    </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <span className="text-xs text-[var(--color-text-tertiary)] uppercase tracking-wide">{label}</span>
      <span className="text-xl font-bold text-[var(--color-text)]">{value}</span>
    </div>
  );
}

export function Stats() {
  const [myStats, setMyStats] = useState<UserStats | null>(null);
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getMyStats(), api.getServerStats()])
      .then(([my, server]) => {
        setMyStats(my);
        setServerStats(server);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto flex flex-col gap-8">
        <Skeleton className="h-8 w-40 rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-10">
      {/* My Stats */}
      {myStats && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2">
            <BarChart2 size={20} className="text-[var(--color-accent)]" />
            My Stats
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Total Plays" value={myStats.total_plays.toString()} />
            <StatCard label="Listening Time" value={formatTime(myStats.total_time_ms)} />
            <StatCard label="Unique Tracks" value={myStats.top_tracks.length.toString()} />
          </div>
          {myStats.top_tracks.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-1">
                Top Tracks
              </h3>
              <div className="divide-y divide-[var(--color-border)]">
                {myStats.top_tracks.slice(0, 5).map((item, i) => (
                  <TrackRow key={item.track.id} track={item.track} count={item.play_count} rank={i + 1} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Server Stats */}
      {serverStats && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2">
            <BarChart2 size={20} className="text-[var(--color-accent)]" />
            Server Stats
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Total Plays" value={serverStats.total_plays.toString()} />
            <StatCard label="Listening Time" value={formatTime(serverStats.total_time_ms)} />
            <StatCard label="Unique Tracks" value={serverStats.unique_tracks.toString()} />
          </div>

          {/* Hourly activity chart */}
          {serverStats.hourly_activity.length > 0 && (
            <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-secondary)]">
                Activity by Hour (UTC)
              </h3>
              <HourlyChart data={serverStats.hourly_activity} />
              <div className="flex justify-between text-[10px] text-[var(--color-text-tertiary)]">
                <span>0h</span>
                <span>6h</span>
                <span>12h</span>
                <span>18h</span>
                <span>23h</span>
              </div>
            </div>
          )}

          {serverStats.top_tracks.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-1">
                Server Top Tracks
              </h3>
              <div className="divide-y divide-[var(--color-border)]">
                {serverStats.top_tracks.slice(0, 5).map((item, i) => (
                  <TrackRow key={item.track.id} track={item.track} count={item.play_count} rank={i + 1} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
