import { useEffect, useState, useRef } from "react";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";
import { Clock, Plus, Check, ArrowUp } from "lucide-react";
import { formatTime } from "../lib/utils";
import { useToast } from "../components/ui/Toast";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import clsx from "clsx";
import { useLocale, t } from "../hooks/useLocale";

interface HistoryEntry {
  track: TrackInfo;
  played_at: string;
  user_id: string;
  play_count: number;
}

function formatDate(iso: string): string {
  const date = new Date(
    iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z",
  );
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  const s = t();
  if (diffMins < 1) return s.time.justNow;
  if (diffMins < 60) return s.time.minutesAgo.replace("{n}", String(diffMins));
  if (diffHours < 24) return s.time.hoursAgo.replace("{n}", String(diffHours));
  if (diffDays < 7) return s.time.daysAgo.replace("{n}", String(diffDays));
  return date.toLocaleDateString();
}

export function History() {
  useLocale();
  const s = t();
  const [exitingKeys, setExitingKeys] = useState<Set<string>>(new Set());
  const [enteringKeys, setEnteringKeys] = useState<Set<string>>(new Set());
  const [isTopVisible, setIsTopVisible] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const isTopVisibleRef = useRef(true);
  const playCountMap = useRef<Map<string, number>>(new Map());
  const playCountInitialized = useRef(false);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [scrollRoot, setScrollRoot] = useState<Element | null>(null);
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    setScrollRoot(document.querySelector("[data-main-scroll]"));
  }, []);

  const {
    items,
    setItems,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
    loadMore,
  } = useInfiniteScroll<HistoryEntry>({
    fetcher: (cursor) => api.getHistory(cursor),
    scrollRoot,
  });

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setShowSkeleton(false), 120);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Sync isTopVisibleRef with state
  useEffect(() => {
    isTopVisibleRef.current = isTopVisible;
  }, [isTopVisible]);

  // Initialize playCountMap from fetched data
  useEffect(() => {
    if (!loading && items.length > 0 && !playCountInitialized.current) {
      playCountInitialized.current = true;
      for (const entry of items) {
        playCountMap.current.set(entry.track.id, entry.play_count);
      }
    }
  }, [loading, items]);

  // IntersectionObserver for top sentinel
  // showSkeleton in deps so effect re-runs when sentinel mounts after data loads
  useEffect(() => {
    const node = topSentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsTopVisible(entry.isIntersecting);
        if (entry.isIntersecting) {
          setNewCount(0);
        }
      },
      { root: scrollRoot, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRoot, showSkeleton]);

  // Real-time track insertion — always insert immediately
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const trackId = detail.track.id;

      // Increment play_count in ref map (immune to animation timing)
      const prevCount = playCountMap.current.get(trackId) ?? 0;
      const nextCount = prevCount + 1;
      playCountMap.current.set(trackId, nextCount);

      setItems((prev) => {
        const existing = prev.find((entry) => entry.track.id === trackId);

        if (existing) {
          const oldKey = `${existing.track.id}-${existing.played_at}`;
          setExitingKeys((s) => new Set(s).add(oldKey));

          const timer = setTimeout(() => {
            setExitingKeys((s) => {
              const n = new Set(s);
              n.delete(oldKey);
              return n;
            });
            setItems((p) =>
              p.filter((x) => `${x.track.id}-${x.played_at}` !== oldKey),
            );
            exitTimers.current.delete(oldKey);
          }, 500);
          exitTimers.current.set(oldKey, timer);
        }

        const newEntry: HistoryEntry = {
          track: detail.track,
          played_at: new Date().toISOString(),
          user_id: detail.user_id,
          play_count: nextCount,
        };
        const newKey = `${newEntry.track.id}-${newEntry.played_at}`;
        setEnteringKeys((s) => new Set(s).add(newKey));

        return [newEntry, ...prev];
      });

      // Badge count: only increment when top is NOT visible
      if (!isTopVisibleRef.current) {
        setNewCount((c) => c + 1);
      }
    };
    window.addEventListener("history-added", handler);
    return () => window.removeEventListener("history-added", handler);
  }, [setItems]);

  // Cleanup exit timers on unmount
  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const { showToast } = useToast();

  const handleAdd = async (track: TrackInfo) => {
    if (addingIds.has(track.id)) return;
    setAddingIds((prev) => new Set(prev).add(track.id));
    try {
      await api.addToQueue({ track_id: track.id });
      setAddedIds((prev) => new Set(prev).add(track.id));
      setTimeout(() => {
        setAddedIds((prev) => {
          const next = new Set(prev);
          next.delete(track.id);
          return next;
        });
      }, 1500);
    } catch {
      showToast(t().toast.failedToAddToQueue, "error");
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">
          {s.history.title}
        </h1>
      </div>

      {showSkeleton ? (
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
          <p className="text-[var(--color-text-secondary)]">
            {s.history.empty}
          </p>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {s.history.emptyAction}
          </p>
        </div>
      ) : (
        <>
          <div ref={topSentinelRef} aria-hidden="true" style={{ height: 0 }} />
          {newCount > 0 && !isTopVisible && (
            <div className="sticky top-3 z-10 flex justify-center pointer-events-none">
              <button
                onClick={() =>
                  scrollRoot?.scrollTo({ top: 0, behavior: "smooth" })
                }
                className="pointer-events-auto flex items-center gap-1.5 px-4 py-1.5 min-h-[32px] rounded-full bg-[var(--color-accent)] text-[#1a1a1a] text-xs font-semibold tracking-wide cursor-pointer"
                style={{
                  animation:
                    "fadeInUp var(--duration-normal) var(--ease-out-soft), badgePulse 2s ease-in-out 400ms infinite",
                  boxShadow:
                    "0 4px 20px color-mix(in srgb, var(--color-accent) 28%, transparent)",
                }}
              >
                <ArrowUp size={11} />
                {s.history.newRecordsBadge.replace("{n}", String(newCount))}
              </button>
            </div>
          )}
          <ul
            className="flex flex-col"
            style={{
              animation: "fadeIn var(--duration-normal) var(--ease-out-soft)",
            }}
          >
            {items.map((entry) => {
              const key = `${entry.track.id}-${entry.played_at}`;
              const isExiting = exitingKeys.has(key);
              const isEntering = enteringKeys.has(key);

              return (
                <li
                  key={key}
                  className={clsx(
                    "flex items-center gap-3 px-3 py-2 rounded-lg",
                    "hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group",
                    isEntering && "border-l-2 border-[var(--color-accent)]",
                  )}
                  style={
                    isExiting
                      ? {
                          animation:
                            "collapseOut var(--duration-slow) var(--ease-out-soft) forwards",
                          pointerEvents: "none",
                        }
                      : isEntering
                        ? {
                            animation:
                              "expandIn var(--duration-slow) var(--ease-out-soft) forwards, fadeInUp var(--duration-slow) var(--ease-out-soft) forwards",
                          }
                        : undefined
                  }
                  onAnimationEnd={
                    isExiting || isEntering
                      ? (e) => {
                          if (e.currentTarget !== e.target) return;
                          if (isExiting && e.animationName === "collapseOut") {
                            // Clear safety timeout
                            const timer = exitTimers.current.get(key);
                            if (timer) {
                              clearTimeout(timer);
                              exitTimers.current.delete(key);
                            }
                            setExitingKeys((s) => {
                              const n = new Set(s);
                              n.delete(key);
                              return n;
                            });
                            setItems((prev) =>
                              prev.filter(
                                (x) => `${x.track.id}-${x.played_at}` !== key,
                              ),
                            );
                          }
                          if (isEntering && e.animationName === "expandIn") {
                            setEnteringKeys((s) => {
                              const n = new Set(s);
                              n.delete(key);
                              return n;
                            });
                          }
                        }
                      : undefined
                  }
                >
                  <TrackThumbnail
                    track={entry.track}
                    sizeClass="w-12 h-12"
                    iconSize={18}
                    className="rounded"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-[var(--color-text)] truncate">
                      {entry.track.title}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] truncate">
                      {entry.track.artist ?? s.history.unknownArtist}
                      {entry.play_count > 1 && (
                        <span className="text-[var(--color-text-tertiary)] ml-1">
                          ·{" "}
                          {s.history.playCount.replace(
                            "{n}",
                            String(entry.play_count),
                          )}
                        </span>
                      )}
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
                  {(() => {
                    const isDone = addedIds.has(entry.track.id);
                    const isPending = addingIds.has(entry.track.id);
                    return (
                      <button
                        onClick={() => handleAdd(entry.track)}
                        disabled={isPending || isDone}
                        className={clsx(
                          "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium",
                          "transition-[color,background-color,opacity] duration-150 cursor-pointer",
                          isDone
                            ? "bg-[var(--color-bg-tertiary)] text-[var(--color-success)] cursor-default"
                            : isPending
                              ? "bg-[var(--color-accent)] text-[#1a1a1a] cursor-not-allowed opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                              : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[#1a1a1a] opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                        )}
                        aria-label={`Add ${entry.track.title} to queue`}
                      >
                        <span className="relative w-3 h-3 flex-shrink-0">
                          <Plus
                            size={12}
                            className={clsx(
                              "absolute inset-0 transition-[opacity,transform] duration-150",
                              isDone
                                ? "opacity-0 scale-75"
                                : "opacity-100 scale-100",
                            )}
                          />
                          <Check
                            size={12}
                            className={clsx(
                              "absolute inset-0 transition-[opacity,transform] duration-150",
                              isDone
                                ? "opacity-100 scale-100"
                                : "opacity-0 scale-75",
                            )}
                          />
                        </span>
                        {s.history.add}
                      </button>
                    );
                  })()}
                </li>
              );
            })}
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
              {s.history.loadMore}
            </button>
          )}

          {/* End-of-list indicator */}
          {!loading && !hasMore && items.length > 0 && (
            <div className="flex items-center gap-3 px-3 py-6">
              <div className="flex-1 h-px bg-[var(--color-border)]" />
              <span className="text-xs text-[var(--color-text-tertiary)] px-2 shrink-0">
                {s.history.tracksCount.replace("{n}", String(items.length))}
              </span>
              <div className="flex-1 h-px bg-[var(--color-border)]" />
            </div>
          )}

          {/* Screen reader announcement */}
          <div aria-live="polite" aria-atomic="false" className="sr-only">
            {loadingMore ? s.history.loadingMoreTracks : ""}
            {!hasMore && items.length > 0
              ? s.history.allTracksLoaded.replace("{n}", String(items.length))
              : ""}
          </div>
        </>
      )}
    </div>
  );
}
