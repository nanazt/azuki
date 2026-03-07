import clsx from "clsx";
import { X, Music } from "lucide-react";
import type { QueueEntry } from "../../../lib/types";
import { Avatar } from "../../ui/Avatar";

interface QueueItemProps {
  entry: QueueEntry;
  index: number;
  position: number;
  onRemove: (index: number) => void;
}

export function QueueItem({ entry, index, position, onRemove }: QueueItemProps) {
  const { track, added_by } = entry;

  return (
    <div
      className={clsx(
        "flex items-center gap-3 px-3 py-2 rounded-lg",
        "hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group"
      )}
    >
      <span className="text-xs text-[var(--color-text-tertiary)] w-5 text-center flex-shrink-0 tabular-nums">
        {position}
      </span>
      {track.thumbnail_url ? (
        <img
          src={track.thumbnail_url}
          alt={track.title}
          className="w-9 h-9 rounded object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-9 h-9 rounded bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
          <Music size={14} className="text-[var(--color-text-tertiary)]" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--color-text)] truncate font-medium">
          {track.title}
        </div>
        <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] min-w-0">
          <span className="truncate">{track.artist ?? "Unknown artist"}</span>
          {added_by?.username && (
            <>
              <span className="text-[var(--color-text-tertiary)] flex-shrink-0">·</span>
              <Avatar src={added_by.avatar_url} username={added_by.username} size="xs" className="flex-shrink-0" />
              <span className="text-[var(--color-text-secondary)] truncate">{added_by.username}</span>
            </>
          )}
        </div>
      </div>
      <button
        onClick={() => onRemove(index)}
        className={clsx(
          "flex-shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-[var(--color-text-tertiary)]",
          "opacity-0 group-hover:opacity-100 hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
          "transition-all duration-100 cursor-pointer touch-manipulation"
        )}
        aria-label={`Remove ${track.title} from queue`}
      >
        <X size={14} />
      </button>
    </div>
  );
}
