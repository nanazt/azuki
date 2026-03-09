import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { ListMusic, Search, Loader2, X } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { usePlayerStore } from "../../../stores/playerStore";
import {
  useDownloadStore,
  type DownloadEntry,
} from "../../../stores/downloadStore";
import { api } from "../../../lib/api";
import { QueueItem, QueueItemContent } from "./QueueItem";
import { usePlayer } from "../../../hooks/usePlayer";
import { useToast } from "../../../hooks/useToast";
import { Avatar } from "../../ui/Avatar";
import { TrackThumbnail } from "../../ui/TrackThumbnail";

interface QueuePanelProps {
  onOpenSearch?: () => void;
}

export function QueuePanel({ onOpenSearch }: QueuePanelProps) {
  const { showToast } = useToast();
  const { moveInQueue, playAt, skip } = usePlayer();
  const playState = usePlayerStore((s) => s.playState);
  const queue = usePlayerStore((s) => s.queue);
  const currentAddedBy = usePlayerStore((s) => s.currentAddedBy);
  const downloads = useDownloadStore((s) => s.downloads);

  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.status === "downloading",
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const currentTrack = playState.status !== "idle" ? playState.track : null;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortableIds = useMemo(
    () => queue.map((entry, i) => `${entry.track.id}::${i}`),
    [queue],
  );

  const parseIndex = (id: string) => parseInt(id.split("::")[1], 10);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveIndex(parseIndex(event.active.id as string));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveIndex(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      moveInQueue(parseIndex(active.id as string), parseIndex(over.id as string));
    },
    [moveInQueue],
  );

  const handleRemove = useCallback(
    async (position: number) => {
      try {
        await api.removeFromQueue(position);
        showToast("Removed from queue", "success");
      } catch (err) {
        console.error("Failed to remove from queue", err);
        showToast("Failed to remove from queue", "error");
      }
    },
    [showToast],
  );

  const handlePlayAt = useCallback(
    async (position: number) => {
      try {
        await playAt(position);
      } catch (err) {
        console.error("Failed to play from queue", err);
        showToast("Failed to play track", "error");
      }
    },
    [playAt, showToast],
  );

  const handleSkipCurrent = useCallback(async () => {
    try {
      await skip();
    } catch (err) {
      console.error("Failed to skip track", err);
      showToast("Failed to skip track", "error");
    }
  }, [skip, showToast]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
        <ListMusic size={16} className="text-[var(--color-text-secondary)]" />
        <span className="text-sm font-semibold text-[var(--color-text)]">
          Queue
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {/* Now playing */}
        {currentTrack && (
          <div className="mb-3">
            <div className="px-4 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                Now Playing
              </span>
            </div>
            <div className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg bg-[var(--color-bg-tertiary)] group">
              <TrackThumbnail track={currentTrack} sizeClass="w-9 h-9" iconSize={14} className="rounded" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--color-text)] truncate">
                  {currentTrack.title}
                </div>
                <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] min-w-0">
                  {currentTrack.artist && (
                    <span className="truncate">{currentTrack.artist}</span>
                  )}
                  {currentAddedBy?.username && (
                    <>
                      {currentTrack.artist && <span className="text-[var(--color-text-tertiary)] flex-shrink-0">·</span>}
                      <Avatar src={currentAddedBy.avatar_url} username={currentAddedBy.username} size="xs" className="flex-shrink-0" />
                      <span className="text-[var(--color-text-secondary)] truncate">{currentAddedBy.username}</span>
                    </>
                  )}
                </div>
              </div>
              <button
                onClick={handleSkipCurrent}
                className={clsx(
                  "flex-shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-[var(--color-text-tertiary)]",
                  "hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
                  "transition-all duration-100 cursor-pointer touch-manipulation",
                )}
                aria-label={`Skip ${currentTrack.title}`}
              >
                <X size={14} />
              </button>
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
            <div className="px-4 py-1 flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                Up Next
              </span>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={sortableIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="px-1">
                  {queue.map((entry, index) => (
                    <QueueItem
                      key={`${entry.track.id}-${index}`}
                      entry={entry}
                      index={index}
                      onRemove={handleRemove}
                      onPlayAt={handlePlayAt}
                    />
                  ))}
                </div>
              </SortableContext>
              <DragOverlay>
                {activeIndex != null && queue[activeIndex] && (
                  <QueueItemContent
                    entry={queue[activeIndex]}
                    index={activeIndex}
                    onRemove={handleRemove}
                    isOverlay
                  />
                )}
              </DragOverlay>
            </DndContext>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <ListMusic
              size={28}
              className="text-[var(--color-text-tertiary)]"
            />
            <p className="text-sm text-[var(--color-text-secondary)]">
              Queue is empty
            </p>
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
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
  const hasMetadata = !!download.title;

  return (
    <div className="relative border-l-2 border-[var(--color-accent)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2">
        {/* Thumbnail / Skeleton */}
        {hasMetadata ? (
          <div className="relative w-9 h-9 flex-shrink-0 rounded overflow-hidden">
            {download.thumbnail_url ? (
              <img
                src={download.thumbnail_url}
                alt=""
                className="w-full h-full object-cover brightness-50"
              />
            ) : (
              <div className="w-full h-full bg-[var(--color-bg-tertiary)]" />
            )}
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={14} className="text-[var(--color-accent)] animate-spin" />
            </div>
          </div>
        ) : (
          <div className="w-9 h-9 flex-shrink-0 rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
        )}

        {/* Text content */}
        <div className="min-w-0 flex-1">
          {hasMetadata ? (
            <>
              <div className="text-sm font-medium text-[var(--color-text)] truncate">
                {download.title}
              </div>
              <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] min-w-0">
                {download.artist && (
                  <span className="truncate">{download.artist}</span>
                )}
                {download.user_info?.username && (
                  <>
                    {download.artist && <span className="text-[var(--color-text-tertiary)] flex-shrink-0">·</span>}
                    <Avatar src={download.user_info.avatar_url ?? null} username={download.user_info.username} size="xs" className="flex-shrink-0" />
                    <span className="truncate">{download.user_info.username}</span>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="h-4 w-[70%] rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
              <div className="flex items-center gap-1 mt-1">
                <div className="h-3 w-[40%] rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
                {download.user_info?.username && (
                  <>
                    <span className="text-[var(--color-text-tertiary)] flex-shrink-0">·</span>
                    <Avatar src={download.user_info.avatar_url ?? null} username={download.user_info.username} size="xs" className="flex-shrink-0" />
                    <span className="text-xs text-[var(--color-text-secondary)] truncate">{download.user_info.username}</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Speed/percent */}
        {hasMetadata && percent > 0 && (
          <span className="text-[10px] text-[var(--color-text-tertiary)] tabular-nums flex-shrink-0">
            {percent}%{speed && ` · ${speed}`}
          </span>
        )}
      </div>

      {/* Bottom progress bar */}
      <div className="h-0.5 bg-[var(--color-bg-tertiary)]">
        <div
          className="h-full bg-[var(--color-accent)] transition-all duration-300"
          style={{ width: percent > 0 ? `${percent}%` : '0%' }}
        />
      </div>
    </div>
  );
}
