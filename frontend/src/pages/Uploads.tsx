import { useState, useCallback, useEffect, useRef } from "react";
import { Upload, Plus, Loader2, Trash2, ArrowUp } from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api";
import { useToast } from "../hooks/useToast";
import { useLocale, t } from "../hooks/useLocale";
import { useAuthStore } from "../stores/authStore";
import type { TrackInfo, UploadsResponse } from "../lib/types";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useAnimatedList } from "../hooks/useAnimatedList";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function UploadRow({
  track,
  onUpdate,
  isAdmin,
  onDelete,
  animationStatus,
  onAnimationEnd,
}: {
  track: TrackInfo;
  onUpdate: () => void;
  isAdmin: boolean;
  onDelete: (id: string) => void;
  animationStatus?: "entering" | "stable" | "exiting";
  onAnimationEnd?: () => void;
}) {
  const { showToast } = useToast();
  useLocale();
  const s = t();
  const [editing, setEditing] = useState<"title" | "artist" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleEdit = (field: "title" | "artist") => {
    setEditing(field);
    setEditValue(field === "title" ? track.title : track.artist || "");
  };

  const handleSave = async () => {
    if (!editing) return;
    try {
      await api.updateTrack(track.id, {
        [editing]: editValue.trim() || undefined,
      });
      onUpdate();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t().toast.updateFailed,
        "error",
      );
    }
    setEditing(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(null);
  };

  const handleAddToQueue = async () => {
    setAdding(true);
    try {
      await api.addToQueue({ track_id: track.id });
      showToast(t().toast.addedToQueue, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : t().toast.failed, "error");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteTrack(track.id);
      onDelete(track.id);
      showToast(t().toast.deleted, "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t().toast.deleteFailed,
        "error",
      );
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <li
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-hover)] rounded-md group transition-colors"
      style={
        animationStatus === "entering"
          ? {
              animation:
                "expandIn var(--duration-slow) var(--ease-out-soft) forwards, fadeInUp var(--duration-slow) var(--ease-out-soft) forwards",
            }
          : animationStatus === "exiting"
            ? {
                animation:
                  "collapseOut var(--duration-slow) var(--ease-out-soft) forwards",
                pointerEvents: "none" as const,
              }
            : undefined
      }
      onAnimationEnd={
        animationStatus !== "stable" && animationStatus
          ? (e) => {
              if (e.currentTarget !== e.target) return;
              if (
                (animationStatus === "entering" &&
                  e.animationName === "expandIn") ||
                (animationStatus === "exiting" &&
                  e.animationName === "collapseOut")
              ) {
                onAnimationEnd?.();
              }
            }
          : undefined
      }
    >
      {/* Icon */}
      <div className="w-10 h-10 rounded bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
        <Upload size={16} className="text-[var(--color-text-tertiary)]" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {editing === "title" ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="w-full text-sm bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text)] outline-none"
          />
        ) : (
          <p
            className="text-sm text-[var(--color-text)] truncate cursor-pointer hover:underline"
            onClick={() => handleEdit("title")}
          >
            {track.title}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          {editing === "artist" ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-tertiary)] outline-none"
            />
          ) : (
            <span
              className="truncate cursor-pointer hover:underline"
              onClick={() => handleEdit("artist")}
            >
              {track.artist || s.uploads.unknownArtist}
            </span>
          )}
          {track.duration_ms > 0 && (
            <>
              <span>·</span>
              <span>{formatDuration(track.duration_ms)}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div
        className={clsx(
          "flex items-center gap-1",
          !confirmDelete &&
            "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          (adding || deleting) && "opacity-100",
          confirmDelete && "opacity-100",
        )}
      >
        {confirmDelete ? (
          <>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="px-2 py-1.5 text-xs rounded-md transition-colors touch-manipulation min-h-[44px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              {s.uploads.cancel}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-2 py-1.5 text-xs rounded-md transition-colors touch-manipulation min-h-[44px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 font-medium"
            >
              {deleting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                s.uploads.deleteConfirm
              )}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleAddToQueue}
              disabled={adding}
              className={clsx(
                "p-2 rounded-md transition-colors touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center",
                "text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]",
              )}
              aria-label={s.uploads.addToQueue}
            >
              {adding ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
            </button>
            {isAdmin && (
              <button
                onClick={() => setConfirmDelete(true)}
                className={clsx(
                  "p-2 rounded-md transition-colors touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center",
                  "text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
                )}
                aria-label={s.uploads.deleteTrack}
              >
                <Trash2 size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function UploadsPage() {
  useLocale();
  const s = t();
  const [total, setTotal] = useState(0);
  const isAdmin = useAuthStore((st) => st.isAdmin);
  const [isTopVisible, setIsTopVisible] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const isTopVisibleRef = useRef(true);
  const [scrollRoot, setScrollRoot] = useState<Element | null>(null);

  const {
    items: tracks,
    setItems: setTracks,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
    reload,
    loadMore,
  } = useInfiniteScroll<TrackInfo, UploadsResponse>({
    fetcher: (cursor) => api.getUploads(cursor),
    onResponse: (res) => setTotal(res.total),
  });

  const getKey = useCallback((t: TrackInfo) => t.id, []);
  const { displayItems, handleAnimationEnd } = useAnimatedList(tracks, getKey);

  const handleDelete = useCallback(
    (id: string) => {
      setTracks((prev) => prev.filter((t) => t.id !== id));
      setTotal((t) => t - 1);
    },
    [setTracks],
  );

  useEffect(() => {
    setScrollRoot(document.querySelector("[data-main-scroll]"));
  }, []);

  // Sync isTopVisibleRef with state
  useEffect(() => {
    isTopVisibleRef.current = isTopVisible;
  }, [isTopVisible]);

  // IntersectionObserver for top sentinel
  // loading in deps so effect re-runs when sentinel mounts after data loads
  useEffect(() => {
    const node = topSentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsTopVisible(entry.isIntersecting);
        if (entry.isIntersecting) setNewCount(0);
      },
      { root: scrollRoot, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRoot, loading]);

  // Real-time upload-added event listener
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const track: TrackInfo = detail.track;

      let inserted = false;
      setTracks((prev) => {
        if (prev.some((t) => t.id === track.id)) return prev;
        inserted = true;
        return [track, ...prev];
      });

      if (!inserted) return;
      setTotal((t) => t + 1);

      if (!isTopVisibleRef.current) {
        setNewCount((c) => c + 1);
      }
    };
    window.addEventListener("upload-added", handler);
    return () => window.removeEventListener("upload-added", handler);
  }, [setTracks]);

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">
          {s.uploads.title}
        </h1>
        {total > 0 && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {s.uploads.uploadedTracks.replace("{n}", String(total))}
          </p>
        )}
      </div>

      {loading && tracks.length === 0 && (
        <div className="flex items-center justify-center py-10">
          <Loader2
            size={24}
            className="text-[var(--color-text-tertiary)] animate-spin"
          />
        </div>
      )}

      {!loading && tracks.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Upload size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">
            {s.uploads.empty}
          </p>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            {s.uploads.emptyHint}
          </p>
        </div>
      )}

      {tracks.length > 0 && (
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
                {s.uploads.newFilesBadge.replace("{n}", String(newCount))}
              </button>
            </div>
          )}
          <ul role="list" className="flex flex-col gap-0">
            {displayItems.map(({ item: track, status, key }) => (
              <UploadRow
                key={key}
                track={track}
                onUpdate={reload}
                isAdmin={isAdmin}
                onDelete={handleDelete}
                animationStatus={status}
                onAnimationEnd={() => handleAnimationEnd(key)}
              />
            ))}
          </ul>
        </>
      )}

      {/* Sentinel + skeleton loading */}
      {hasMore && (
        <div ref={sentinelRef}>
          {loadingMore ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2">
                <div className="w-10 h-10 rounded bg-[var(--color-bg-tertiary)] animate-pulse flex-shrink-0" />
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
          {s.uploads.loadMore}
        </button>
      )}

      {/* End-of-list indicator */}
      {!loading && !hasMore && tracks.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-6">
          <div className="flex-1 h-px bg-[var(--color-border)]" />
          <span className="text-xs text-[var(--color-text-tertiary)] px-2 shrink-0">
            {s.uploads.tracksCount.replace("{n}", String(tracks.length))}
          </span>
          <div className="flex-1 h-px bg-[var(--color-border)]" />
        </div>
      )}

      {/* Screen reader announcement */}
      <div aria-live="polite" aria-atomic="false" className="sr-only">
        {loadingMore ? s.uploads.loadingMoreTracks : ""}
        {!hasMore && tracks.length > 0
          ? s.uploads.allTracksLoaded.replace("{n}", String(tracks.length))
          : ""}
      </div>
    </div>
  );
}
