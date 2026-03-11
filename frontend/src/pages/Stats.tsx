import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Stats as StatsData, ArtistStat, TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { BarChart2, Disc, Flame, Trophy, Music, Users } from "lucide-react";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useLocale, t } from "../hooks/useLocale";

// ─── Chart Configuration ───
// Edit these values to adjust chart display criteria.
const CHART_CONFIG = {
  /** Heatmap: number of weeks to display */
  heatmapWeeks: 26,
  /** Heatmap: minimum cell size in pixels */
  heatmapMinCellSize: 8,
  /** Heatmap: color thresholds as fraction of max (relative scale) */
  heatmapThresholds: [0.2, 0.4, 0.6, 0.8] as const,
  /** TrendChart: show X-axis label every N data points */
  trendLabelInterval: 7,
  /** DowChart: minimum bar width percentage (visibility floor) */
  dowMinBarPct: 4,
} as const;

// ─── Helpers ───

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function formatDuration(ms: number): string {
  const s = t();
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0)
    return s.stats.durationHM
      .replace("{h}", String(hours))
      .replace("{m}", String(minutes));
  return s.stats.durationM.replace("{m}", String(minutes));
}

function formatListeningTime(ms: number): string {
  const s = t();
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0)
    return s.stats.durationHM
      .replace("{h}", String(hours))
      .replace("{m}", String(minutes));
  return s.stats.durationM.replace("{m}", String(minutes));
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
      {icon && (
        <span className="text-[var(--color-text-secondary)]">{icon}</span>
      )}
      <span className="text-sm font-semibold text-[var(--color-text)] tabular-nums leading-none">
        {value}
      </span>
      <span className="text-xs text-[var(--color-text-tertiary)] leading-none">
        {label}
      </span>
    </div>
  );
}

function HeatmapSkeleton() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(11);
  const gap = 2;
  const numWeeks = CHART_CONFIG.heatmapWeeks + 1;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const available = el.clientWidth - 28;
      const size = Math.floor((available - gap * (numWeeks - 1)) / numWeeks);
      setCellSize(Math.max(size, CHART_CONFIG.heatmapMinCellSize));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <Skeleton className="h-5 w-24 rounded" />
      <div ref={containerRef}>
        <div
          className="flex flex-col"
          style={{ marginTop: 20, gap, paddingLeft: 24 }}
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="w-full rounded-sm" height={cellSize} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 justify-end mt-1">
          <Skeleton className="h-2 w-6 rounded" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="w-2 h-2 rounded-sm" />
          ))}
          <Skeleton className="h-2 w-6 rounded" />
        </div>
      </div>
    </div>
  );
}

function StatChipSkeleton() {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] animate-pulse">
      <div className="w-3 h-3 rounded-full bg-[var(--color-bg-hover)]" />
      <div className="h-3.5 w-10 rounded bg-[var(--color-bg-hover)]" />
      <div className="h-3 w-8 rounded bg-[var(--color-bg-hover)]" />
    </div>
  );
}

// ─── Contribution Heatmap ───

const HEATMAP_COLORS = {
  empty: "var(--color-bg-tertiary)",
  colors: [
    "var(--color-bg-tertiary)",
    "var(--color-heatmap-1)",
    "var(--color-heatmap-2)",
    "var(--color-heatmap-3)",
    "var(--color-heatmap-4)",
    "var(--color-heatmap-5)",
  ],
};

function getDowLabels() {
  const s = t();
  return [
    s.stats.dowShort.mon,
    "",
    s.stats.dowShort.wed,
    "",
    s.stats.dowShort.fri,
    "",
    s.stats.dowShort.sun,
  ];
}

function getMonthLabels() {
  const s = t();
  return [
    s.stats.months.jan,
    s.stats.months.feb,
    s.stats.months.mar,
    s.stats.months.apr,
    s.stats.months.may,
    s.stats.months.jun,
    s.stats.months.jul,
    s.stats.months.aug,
    s.stats.months.sep,
    s.stats.months.oct,
    s.stats.months.nov,
    s.stats.months.dec,
  ];
}

function ContributionHeatmap({
  data,
}: {
  data: { date: string; listened_ms: number }[];
}) {
  const s = t();
  const heatmap = HEATMAP_COLORS;
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [cellSize, setCellSize] = useState(11);

  const DOW_LABELS = getDowLabels();
  const MONTH_LABELS = getMonthLabels();

  // Build 26-week × 7-day grid
  const today = new Date();
  const todayStr = fmtDate(today);
  const todayDow = (today.getDay() + 6) % 7; // Mon=0
  const totalDays = CHART_CONFIG.heatmapWeeks * 7 + todayDow + 1;
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
    const dateStr = fmtDate(d);
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
    if (ratio < CHART_CONFIG.heatmapThresholds[0]) return heatmap.colors[1];
    if (ratio < CHART_CONFIG.heatmapThresholds[1]) return heatmap.colors[2];
    if (ratio < CHART_CONFIG.heatmapThresholds[2]) return heatmap.colors[3];
    if (ratio < CHART_CONFIG.heatmapThresholds[3]) return heatmap.colors[4];
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
      const size = Math.floor(
        (available - gap * (weeks.length - 1)) / weeks.length,
      );
      setCellSize(Math.max(size, CHART_CONFIG.heatmapMinCellSize));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weeks.length]);

  return (
    <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        {s.stats.listeningActivity}
      </h3>
      <div className="relative">
        <div ref={containerRef} className="overflow-hidden">
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
                    whiteSpace: "nowrap",
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
                          boxShadow:
                            cell.dateStr === todayStr
                              ? "inset 0 0 0 1.5px var(--color-accent)"
                              : "none",
                        }}
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const parentRect =
                            containerRef.current?.getBoundingClientRect();
                          if (parentRect) {
                            setTooltip({
                              x: rect.left - parentRect.left + rect.width / 2,
                              y: rect.top - parentRect.top - 4,
                              text:
                                cell.ms > 0
                                  ? `${cell.dateStr}: ${formatDuration(cell.ms)}`
                                  : cell.dateStr,
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
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            {s.stats.less}
          </span>
          {heatmap.colors.map((c, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: c,
              }}
            />
          ))}
          <span className="text-[10px] text-[var(--color-text-tertiary)]">
            {s.stats.more}
          </span>
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

function TrendChart({
  data,
}: {
  data: { date: string; play_count: number }[];
}) {
  const s = t();
  if (data.length === 0) return null;

  const accent = "var(--color-accent)";
  const maxCount = Math.max(...data.map((d) => d.play_count), 1);
  const w = 100;
  const h = 40;
  const padding = 2;
  const effectiveW = w - padding * 2;
  const effectiveH = h - padding * 2;

  const points = data.map((d, i) => {
    const x =
      padding +
      (data.length > 1 ? (i / (data.length - 1)) * effectiveW : effectiveW / 2);
    const y = padding + effectiveH - (d.play_count / maxCount) * effectiveH;
    return { x, y, ...d };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${h} L ${points[0].x} ${h} Z`;

  // X-axis labels: show every 7 days
  const xLabels = points.filter(
    (_, i) => i % CHART_CONFIG.trendLabelInterval === 0,
  );

  return (
    <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        {s.stats.last30Days}
      </h3>
      <svg viewBox={`0 0 ${w} ${h + 16}`} className="w-full h-40">
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
            <circle cx={p.x} cy={p.y} r="0.8" fill={accent} />
            <title>{`${p.date}: ${s.stats.playsCount.replace("{n}", String(p.play_count))}`}</title>
            <rect
              x={p.x - 1.5}
              y={padding}
              width={3}
              height={effectiveH}
              fill="transparent"
            >
              <title>{`${p.date}: ${s.stats.playsCount.replace("{n}", String(p.play_count))}`}</title>
            </rect>
          </g>
        ))}
        {/* X labels */}
        {xLabels.map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={h + 11}
            textAnchor="middle"
            fill="var(--color-text-tertiary)"
            fontSize="3"
          >
            {p.date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ─── DowChart (day-of-week horizontal bars) ───

function getDowFullLabels() {
  const s = t();
  return [
    s.stats.dow.mon,
    s.stats.dow.tue,
    s.stats.dow.wed,
    s.stats.dow.thu,
    s.stats.dow.fri,
    s.stats.dow.sat,
    s.stats.dow.sun,
  ];
}

function DowChart({ data }: { data: number[] }) {
  const DOW_FULL_LABELS = getDowFullLabels();
  const max = Math.max(...data, 1);
  const durations = data.map(formatDuration);
  const maxDurLen = Math.max(...durations.map((d) => d.length));

  return (
    <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">
        {t().stats.activityByDay}
      </h3>
      <div className="flex flex-col gap-1.5">
        {DOW_FULL_LABELS.map((label, i) => {
          const pct = (data[i] / max) * 100;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-text-secondary)] w-5 text-left">
                {label}
              </span>
              <div className="flex-1 h-5 bg-[var(--color-bg)] rounded overflow-hidden relative">
                <div
                  className="h-full rounded transition-all"
                  style={{
                    width: `${Math.max(pct, CHART_CONFIG.dowMinBarPct)}%`,
                    backgroundColor: "var(--color-accent)",
                  }}
                />
              </div>
              <span
                className="text-xs text-[var(--color-text-secondary)] text-right flex-shrink-0"
                style={{ minWidth: `${maxDurLen}ch` }}
              >
                {durations[i]}
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
  const s = t();
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
        {s.stats.playsCount.replace("{n}", String(count))}
      </span>
    </div>
  );
}

// ─── ArtistRow ───

function ArtistRow({ artist, rank }: { artist: ArtistStat; rank: number }) {
  const s = t();
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
          {s.stats.tracksCount.replace("{n}", String(artist.track_count))} ·{" "}
          {formatDuration(artist.total_listened_ms)}
        </p>
      </div>
      <span className="text-xs text-[var(--color-text-secondary)] flex-shrink-0">
        {s.stats.playsCount.replace("{n}", String(artist.play_count))}
      </span>
    </div>
  );
}

// ─── Main Stats Page ───

export function Stats() {
  useLocale();
  const s = t();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);
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

  const tracks = useInfiniteScroll<{ track: TrackInfo; play_count: number }>({
    fetcher: fetchTracks,
  });
  const artists = useInfiniteScroll<ArtistStat>({ fetcher: fetchArtists });

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

  // Hold skeleton briefly for smooth transition
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setShowSkeleton(false), 120);
      return () => clearTimeout(timer);
    }
  }, [loading]);

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

  if (showSkeleton) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
        <Skeleton className="h-7 w-28 rounded" />
        <div className="flex flex-wrap justify-center gap-3">
          <StatChipSkeleton />
          <StatChipSkeleton />
          <StatChipSkeleton />
          <StatChipSkeleton />
          <StatChipSkeleton />
        </div>
        <HeatmapSkeleton />
        {/* Charts skeleton — matches TrendChart / DowChart structure */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
            <Skeleton className="h-5 w-20 rounded" />
            <Skeleton className="h-40 w-full rounded" />
          </div>
          <div className="flex-1 p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col gap-4">
            <Skeleton className="h-5 w-24 rounded" />
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Skeleton className="w-7 h-3 rounded" />
                  <Skeleton className="flex-1 h-5 rounded" />
                  <Skeleton className="w-12 h-3 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* Ranking section skeleton */}
        <div>
          <div className="border-b border-[var(--color-border)]">
            <div className="flex">
              <div className="flex-1 py-3 flex justify-center">
                <Skeleton className="h-4 w-20 rounded" />
              </div>
              <div className="flex-1 py-3 flex justify-center">
                <Skeleton className="h-4 w-20 rounded" />
              </div>
            </div>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="w-5 h-4 rounded" />
                <Skeleton className="w-9 h-9 rounded-md" />
                <div className="flex-1 flex flex-col gap-1">
                  <Skeleton className="h-4 w-3/4 rounded" />
                  <Skeleton className="h-3 w-1/2 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div
        className="p-6 max-w-3xl mx-auto flex flex-col items-center gap-4 mt-20"
        style={{
          animation: "fadeIn var(--duration-slow) var(--ease-out-soft)",
        }}
      >
        <p className="text-[var(--color-text-secondary)]">
          {s.stats.failedToLoad}
        </p>
        <button
          onClick={fetchStats}
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[#1a1a1a] text-sm hover:opacity-90 transition-opacity"
        >
          {s.stats.retry}
        </button>
      </div>
    );
  }

  if (stats.total_plays === 0) {
    return (
      <div
        className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6"
        style={{
          animation: "fadeIn var(--duration-slow) var(--ease-out-soft)",
        }}
      >
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--color-text)]">
            {s.stats.title}
          </h1>
        </div>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Music size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">{s.stats.empty}</p>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {s.stats.emptyAction}
          </p>
        </div>
      </div>
    );
  }

  const statChips = [
    {
      label: s.stats.plays,
      value: stats.total_plays.toLocaleString(),
      icon: <BarChart2 size={12} />,
    },
    {
      label: s.stats.listened,
      value: formatListeningTime(stats.total_time_ms),
      icon: <Music size={12} />,
    },
    {
      label: s.stats.tracks,
      value: stats.unique_tracks.toLocaleString(),
      icon: <Disc size={12} />,
    },
    {
      label: s.stats.streak,
      value: `${stats.streak.current}d`,
      icon: <Flame size={12} />,
    },
    ...(stats.peak_day
      ? [
          {
            label: s.stats.peak,
            value: `${stats.peak_day.play_count}`,
            icon: <Trophy size={12} />,
          },
        ]
      : []),
  ];

  return (
    <div
      className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6"
      style={{ animation: "fadeIn var(--duration-slow) var(--ease-out-soft)" }}
    >
      {/* Title */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">
          {s.stats.title}
        </h1>
      </div>

      {/* Stat Chips */}
      <div className="flex flex-wrap justify-center gap-3">
        {statChips.map((chip) => (
          <StatChip
            key={chip.label}
            label={chip.label}
            value={chip.value}
            icon={chip.icon}
          />
        ))}
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
              {s.stats.topTracks}
            </button>
            <button
              onClick={() => setActiveTab("artists")}
              className={`flex-1 py-3 text-sm font-medium text-center transition-colors ${
                activeTab === "artists"
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
            >
              {s.stats.topArtists}
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
        <div className={activeTab === "tracks" ? "block" : "hidden"}>
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
                <div
                  ref={tracks.sentinelRef}
                  className="py-4 flex justify-center"
                >
                  {tracks.loadingMore && (
                    <div
                      className="w-5 h-5 rounded-full animate-spin"
                      style={{
                        border: "2px solid var(--color-accent-faint)",
                        borderTopColor: "var(--color-accent)",
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Top Artists List */}
        <div className={activeTab === "artists" ? "block" : "hidden"}>
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
                <div
                  ref={artists.sentinelRef}
                  className="py-4 flex justify-center"
                >
                  {artists.loadingMore && (
                    <div
                      className="w-5 h-5 rounded-full animate-spin"
                      style={{
                        border: "2px solid var(--color-accent-faint)",
                        borderTopColor: "var(--color-accent)",
                      }}
                    />
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
