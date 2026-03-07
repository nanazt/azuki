import { forwardRef } from "react";
import clsx from "clsx";
import { GripVertical, X } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { QueueEntry } from "../../../lib/types";
import { Avatar } from "../../ui/Avatar";
import { TrackThumbnail } from "../../ui/TrackThumbnail";

interface QueueItemProps {
  entry: QueueEntry;
  index: number;
  onRemove: (index: number) => void;
}

export function QueueItem({ entry, index, onRemove }: QueueItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `queue-${index}` });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <QueueItemContent
      ref={setNodeRef}
      entry={entry}
      index={index}
      onRemove={onRemove}
      isDragging={isDragging}
      style={style}
      dragHandleProps={{ ...attributes, ...listeners }}
    />
  );
}

interface QueueItemContentProps {
  entry: QueueEntry;
  index: number;
  onRemove: (index: number) => void;
  isDragging?: boolean;
  isOverlay?: boolean;
  style?: React.CSSProperties;
  dragHandleProps?: Record<string, unknown>;
}

export const QueueItemContent = forwardRef<HTMLDivElement, QueueItemContentProps>(
  function QueueItemContent(
    { entry, index, onRemove, isDragging, isOverlay, style, dragHandleProps },
    ref,
  ) {
    const { track, added_by } = entry;

    return (
      <div
        ref={ref}
        style={style}
        className={clsx(
          "flex items-center gap-2 px-3 py-2 rounded-lg",
          "hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group",
          isDragging && "opacity-30",
          isOverlay &&
            "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg shadow-xl opacity-95",
        )}
      >
        <button
          type="button"
          className={clsx(
            "flex-shrink-0 flex items-center justify-center w-5 text-[var(--color-text-tertiary)]",
            "opacity-40 group-hover:opacity-100 cursor-grab active:cursor-grabbing touch-none",
            "[@media(hover:none)]:opacity-100",
          )}
          {...dragHandleProps}
        >
          <GripVertical size={14} />
        </button>
        <TrackThumbnail
          track={track}
          sizeClass="w-9 h-9"
          iconSize={14}
          className="rounded"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-[var(--color-text)] truncate font-medium">
            {track.title}
          </div>
          <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] min-w-0">
            <span className="truncate">
              {track.artist ?? "Unknown artist"}
            </span>
            {added_by?.username && (
              <>
                <span className="text-[var(--color-text-tertiary)] flex-shrink-0">
                  ·
                </span>
                <Avatar
                  src={added_by.avatar_url}
                  username={added_by.username}
                  size="xs"
                  className="flex-shrink-0"
                />
                <span className="text-[var(--color-text-secondary)] truncate">
                  {added_by.username}
                </span>
              </>
            )}
          </div>
        </div>
        {!isOverlay && (
          <button
            onClick={() => onRemove(index)}
            className={clsx(
              "flex-shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-[var(--color-text-tertiary)]",
              "opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
              "transition-all duration-100 cursor-pointer touch-manipulation",
            )}
            aria-label={`Remove ${track.title} from queue`}
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  },
);
