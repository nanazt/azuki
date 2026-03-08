import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Stats as StatsData, ArtistStat, TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { BarChart2, Disc, Flame, Trophy, Music, Users } from "lucide-react";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";

// ─── Helpers ───

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatListeningTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ─── StatCard ───

function StatChip({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] whitespace-nowrap">
      {icon && <span className="text-[var(--color-text-secondary)]">{icon}</span>}
      <span className="text-sm font-semibold text-[var(--color-text)] tabular-nums leading-none">{value}</span>
      <span className="text-xs text-[var(--color-text-tertiary)] leading-none">{label}</span>
    </div>
  );
}

// ─── Contribution Heatmap ───

const HEATMAP_COLORS = {
  empty: "var(--color-bg-tertiary)",
  colors: [
    "var(--color-bg-tertiary)",
    "#FFD4E0",
    "#FFB7C9",
    "#FF9DB5",
    "#FF82A0",
    "#FF6B8A",
  ],
};
const DOW_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function ContributionHeatmap({
  data,
}: {
  data: { date: string; listened_ms: number }[];
}) {
  const heatmap = HEATMAP_COLORS;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [cellSize, setCellSize] = useState(11);

  // Build 26-week × 7-day grid
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todayDow = (today.getDay() + 6) % 7; // Mon=0
  const totalDays = 26 * 7 + todayDow + 1;
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - totalDays + 1);

  // Map date -> listened_ms
  const dataMap = new Map<string, number>();
  for (const d of data) {
    dataMap.set(d.date, d.listened_ms);
  }

  // Build cells: array of weeks, each week has up to 7 days
  const weeks: { date: Date; ms: number; dateStr: string }[][] = [];
  let currentWeek: { date: Date; ms: number; dateStr: string }[] = [];

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = (d.getDay() + 6) % 7;
    if (dow === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push({ date: d, ms: dataMap.get(dateStr) || 0, dateStr });
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  // Color scale
  const maxMs = Math.max(...data.map((d) => d.listened_ms), 1);
  const getColor = (ms: number) => {
    if (ms === 0) return heatmap.empty;
    const ratio = ms / maxMs;
    if (ratio < 0.2) return heatmap.colors[1];
    if (ratio < 0.4) return heatmap.colors[2];
    if (ratio < 0.6) return heatmap.colors[3];
    if (ratio < 0.8) return heatmap.colors[4];
    return heatmap.colors[5];
  };

  // Month labels
  const monthPositions: { label: string; col: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstDay = week[0];
    const month = firstDay.date.getMonth();
    if (month !== lastMonth) {
      monthPositions.push({ label: MONTH_LABELS[month], col: wi });
      lastMonth = month;
    }
  });

  // Calculate cell size to fit container width
  const labelWidth = 28;
  const gap = 2;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const available = el.clientWidth - labelWidth;
      const size = Math.floor((available - gap * (weeks.length - 1)) / weeks.length);
      setCellSize(Math.max(size, 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weeks.length]);

  return (
    <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">Listening Activity</h3>
      <div className="relative">
        <div
          ref={containerRef}
          className="overflow-hidden"
        >
          <div className="flex gap-0.5" style={{ paddingLeft: 24 }}>
            {/* Month labels */}
            <div
              className="flex text-[10px] text-[var(--color-text-secondary)] mb-1"
              style={{
                position: "absolute",
                top: 0,
                left: 24,
              }}
            >
              {monthPositions.map((m, i) => (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    left: m.col * (cellSize + gap),
                  }}
                >
                  {m.label}
                </span>
              ))}
            </div>
          </div>
          <div className="flex" style={{ marginTop: 20 }}>
            {/* Day-of-week labels */}
            <div
              className="flex flex-col flex-shrink-0 text-[10px] text-[var(--color-text-secondary)]"
              style={{ width: 24, gap }}
            >
              {DOW_LABELS.map((label, i) => (
                <div
                  key={i}
                  style={{ height: cellSize, lineHeight: `${cellSize}px` }}
                >
                  {label}
                </div>
              ))}
            </div>
            {/* Grid */}
            <div className="flex" style={{ gap }}>
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col" style={{ gap }}>
                  {Array.from({ length: 7 }).map((_, di) => {
                    const cell = week.find(
                      (c) => (c.date.getDay() + 6) % 7 === di,
                    );
                    if (!cell) {
                      return (
                        <div
                          key={di}
                          style={{ width: cellSize, height: cellSize }}
                        />
                      );
                    }
                    return (
                      <div
                        key={di}
                        className="rounded-[2px] cursor-pointer"
                        style={{
                          width: cellSize,
                          height: cellSize,
                          backgroundColor: getColor(cell.ms),
                          outline: cell.dateStr === todayStr
                            ? "1px solid rgba(255, 183, 201, 0.5)"
                            : "none",
                          outlineOffset: "1px",
                        }}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const parentRect =
                            containerRef.current?.getBoundingClientRect();
                          if (parentRect) {
                            setTooltip({
                              x: rect.left - parentRect.left + rect.width / 2,
                              y: rect.top - parentRect.top - 4,
                              text: cell.ms > 0 ? `${cell.dateStr}: ${formatDuration(cell.ms)}` : cell.dateStr,
                            });
                          }
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-1.5 justify-end mt-1">
          <span className="text-[10px] text-[var(--color-text-tertiary)]">Less</span>
          {heatmap.colors.map((c, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: c }} />
          ))}
          <span className="text-[10px] text-[var(--color-text-tertiary)]">More</span>
        </div>
        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text)] pointer-events-none whitespace-nowrap z-10"
            style={{
              left: tooltip.x,
              top: tooltip.y,
              transform: "translate(-50%, -100%)",
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TrendChart (30-day line chart) ───

function TrendChart({ data }: { data: { date: string; play_count: number }[] }) {
  if (data.length === 0) return null;

  const accent = "#FFB7C9";
  const maxCount = Math.max(...data.map((d) => d.play_count), 1);
  const w = 100;
  const h = 40;
  const padding = 2;
  const effectiveW = w - padding * 2;
  const effectiveH = h - padding * 2;

  const points = data.map((d, i) => {
    const x = padding + (data.length > 1 ? (i / (data.length - 1)) * effectiveW : effectiveW / 2);
    const y = padding + effectiveH - (d.play_count / maxCount) * effectiveH;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${h} L ${points[0].x} ${h} Z`;

  // X-axis labels: show every 7 days
  const xLabels = points.filter((_, i) => i % 7 === 0 || i === points.length - 1);

  return (
    <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        Last 30 Days
      </h3>
      <svg viewBox={`0 0 ${w} ${h + 12}`} className="w-full h-40">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.25} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#trendFill)" />
        <path d={linePath} fill="none" stroke={accent} strokeWidth="0.5" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="0.8" fill={accent} opacity={0.6} />
            <title>{`${p.date}: ${p.play_count} plays`}</title>
            <rect
              x={p.x - 1.5}
              y={padding}
              width={3}
              height={effectiveH}
              fill="transparent"
            >
              <title>{`${p.date}: ${p.play_count} plays`}</title>
            </rect>
          </g>
        ))}
        {/* X labels */}
        {xLabels.map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={h + 8}
            textAnchor="middle"
            fill="var(--color-text-secondary)"
            fontSize="2.5"
          >
            {p.date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ─── DowChart (day-of-week horizontal bars) ───

const DOW_FULL_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function DowChart({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);

  return (
    <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        Activity by Day
      </h3>
      <div className="flex flex-col gap-1.5">
        {DOW_FULL_LABELS.map((label, i) => {
          const pct = (data[i] / max) * 100;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-text-secondary)] w-7 text-left">
                {label}
              </span>
              <div className="flex-1 h-5 bg-[var(--color-bg)] rounded overflow-hidden relative">
                <div
                  className="h-full rounded bg-[var(--color-accent)]/60 transition-all"
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
              <span className="text-xs text-[var(--color-text-secondary)] w-16 text-right">
                {formatDuration(data[i])}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── TrackRow ───

function TrackRow({
  track,
  count,
  rank,
}: {
  track: TrackInfo;
  count: number;
  rank: number;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-[var(--color-text-secondary)] w-5 text-right flex-shrink-0">
        {rank}
      </span>
      <TrackThumbnail
        track={track}
        sizeClass="w-9 h-9"
        iconSize={14}
        className="rounded-md"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--color-text)] truncate">
          {track.title}
        </p>
        {track.artist && (
          <p className="text-xs text-[var(--color-text-secondary)] truncate">
            {track.artist}
          </p>
        )}
      </div>
      <span className="text-xs text-[var(--color-text-secondary)] flex-shrink-0">
        {count} plays
      </span>
    </div>
  );
}

// ─── ArtistRow ───

function ArtistRow({
  artist,
  rank,
}: {
  artist: ArtistStat;
  rank: number;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-[var(--color-text-secondary)] w-5 text-right flex-shrink-0">
        {rank}
      </span>
      <div className="w-9 h-9 rounded-md bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
        <Users size={14} className="text-[var(--color-text-secondary)]" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--color-text)] truncate">
          {artist.artist}
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {artist.track_count} tracks · {formatDuration(artist.total_listened_ms)}
        </p>
      </div>
      <span className="text-xs text-[var(--color-text-secondary)] flex-shrink-0">
        {artist.play_count} plays
      </span>
    </div>
  );
}

// ─── Infinite scroll hook ───

function useInfiniteScroll<T>(
  fetcher: (cursor?: string) => Promise<{ items: T[]; next_cursor: string | null }>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMore = nextCursor !== null;

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetcher(nextCursor!);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.next_cursor);
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }, [fetcher, nextCursor, loadingMore, hasMore]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetcher();
      setItems(res.items);
      setNextCursor(res.next_cursor);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  // Initial load
  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return { items, loading, loadingMore, hasMore, sentinelRef, reload: loadInitial };
}

// ─── Main Stats Page ───

export function Stats() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState<"tracks" | "artists">("tracks");

  const fetchTracks = useCallback(
    (cursor?: string) => api.getTopTracks(cursor),
    [],
  );
  const fetchArtists = useCallback(
    (cursor?: string) => api.getTopArtists(cursor),
    [],
  );

  const tracks = useInfiniteScroll(fetchTracks);
  const artists = useInfiniteScroll(fetchArtists);

  const fetchStats = useCallback(() => {
    setError(false);
    api
      .getStats()
      .then(setStats)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Refresh on track-ended
  useEffect(() => {
    const handler = () => {
      fetchStats();
      tracks.reload();
      artists.reload();
    };
    window.addEventListener("track-ended", handler);
    return () => window.removeEventListener("track-ended", handler);
  }, [fetchStats, tracks.reload, artists.reload]);

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
        <Skeleton className="h-8 w-32 rounded" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-28 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-40 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-6 max-w-3xl mx-auto flex flex-col items-center gap-4 mt-20">
        <p className="text-[var(--color-text-secondary)]">
          Failed to load stats
        </p>
        <button
          onClick={fetchStats}
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[#1a1a1a] text-sm hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      </div>
    );
  }

  if (stats.total_plays === 0) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--color-text)]">Stats</h1>
        </div>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Music size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">No listening history yet.</p>
          <p className="text-sm text-[var(--color-text-tertiary)]">Start listening!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6 pb-32">
      {/* Title */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Stats</h1>
      </div>

      {/* Stat Chips */}
      <div className="flex flex-wrap justify-center gap-3">
        <StatChip
          label="plays"
          value={stats.total_plays.toLocaleString()}
          icon={<BarChart2 size={12} />}
        />
        <StatChip
          label="listened"
          value={formatListeningTime(stats.total_time_ms)}
          icon={<Music size={12} />}
        />
        <StatChip
          label="tracks"
          value={stats.unique_tracks.toLocaleString()}
          icon={<Disc size={12} />}
        />
        <StatChip
          label="streak"
          value={`${stats.streak.current}d`}
          icon={<Flame size={12} />}
        />
        {stats.peak_day && (
          <StatChip
            label="peak"
            value={`${stats.peak_day.play_count}`}
            icon={<Trophy size={12} />}
          />
        )}
      </div>

      {/* Contribution Heatmap */}
      <ContributionHeatmap data={stats.heatmap} />

      {/* Trend + DOW Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TrendChart data={stats.trend} />
        <DowChart data={stats.dow_activity} />
      </div>

      {/* Ranking Tabs */}
      <div>
        {/* Tab Strip */}
        <div className="sticky top-0 z-10 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <div className="flex relative">
            <button
              onClick={() => setActiveTab("tracks")}
              className={`flex-1 py-3 text-sm font-medium text-center transition-colors ${
                activeTab === "tracks"
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              Top Tracks
            </button>
            <button
              onClick={() => setActiveTab("artists")}
              className={`flex-1 py-3 text-sm font-medium text-center transition-colors ${
                activeTab === "artists"
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              Top Artists
            </button>
            {/* Sliding underline */}
            <div
              className="absolute bottom-0 h-0.5 bg-[var(--color-accent)] transition-all duration-200 ease-out"
              style={{
                width: "50%",
                left: activeTab === "tracks" ? "0%" : "50%",
              }}
            />
          </div>
        </div>

        {/* Top Tracks List */}
        <div
          className={activeTab === "tracks" ? "block" : "hidden"}
        >
          {tracks.loading ? (
            <div className="divide-y divide-[var(--color-border)]">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="w-5 h-4 rounded" />
                  <Skeleton className="w-9 h-9 rounded-md" />
                  <div className="flex-1">
                    <Skeleton className="h-4 w-3/4 rounded mb-1" />
                    <Skeleton className="h-3 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {tracks.items.map((item, i) => (
                <TrackRow
                  key={item.track.id}
                  track={item.track}
                  count={item.play_count}
                  rank={i + 1}
                />
              ))}
              {tracks.hasMore && (
                <div ref={tracks.sentinelRef} className="py-4 flex justify-center">
                  {tracks.loadingMore && (
                    <div className="w-5 h-5 border-2 border-[var(--color-accent)]/30 border-t-[var(--color-accent)] rounded-full animate-spin" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Top Artists List */}
        <div
          className={activeTab === "artists" ? "block" : "hidden"}
        >
          {artists.loading ? (
            <div className="divide-y divide-[var(--color-border)]">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="w-5 h-4 rounded" />
                  <Skeleton className="w-9 h-9 rounded-md" />
                  <div className="flex-1">
                    <Skeleton className="h-4 w-3/4 rounded mb-1" />
                    <Skeleton className="h-3 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {artists.items.map((item, i) => (
                <ArtistRow key={item.artist} artist={item} rank={i + 1} />
              ))}
              {artists.hasMore && (
                <div ref={artists.sentinelRef} className="py-4 flex justify-center">
                  {artists.loadingMore && (
                    <div className="w-5 h-5 border-2 border-[var(--color-accent)]/30 border-t-[var(--color-accent)] rounded-full animate-spin" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
