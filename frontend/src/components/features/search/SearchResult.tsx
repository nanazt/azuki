import { Plus } from "lucide-react";
import { TrackThumbnail } from "../../ui/TrackThumbnail";
import clsx from "clsx";
import type { TrackInfo } from "../../../lib/types";
import { formatTime } from "../../../lib/utils";

interface SearchResultProps {
  track: TrackInfo;
  onAdd: (track: TrackInfo) => void;
  adding?: boolean;
}

export function SearchResult({ track, onAdd, adding = false }: SearchResultProps) {
  return (
    <div
      className={clsx(
        "flex items-center gap-3 px-3 py-2 rounded-lg",
        "hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group"
      )}
    >
      <TrackThumbnail track={track} sizeClass="w-12 h-12" iconSize={18} className="rounded" preferExternal />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--color-text)] truncate">
          {track.title}
        </div>
        <div className="text-xs text-[var(--color-text-secondary)] truncate">
          {track.artist ?? "Unknown artist"}
          {track.duration_ms > 0 && (
            <span className="text-[var(--color-text-tertiary)] ml-2">
              {formatTime(track.duration_ms)}
            </span>
          )}
        </div>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={adding}
        className={clsx(
          "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium",
          "transition-all duration-150 cursor-pointer",
          adding
            ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] cursor-not-allowed"
            : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[#1a1a1a] opacity-0 group-hover:opacity-100"
        )}
        aria-label={`Add ${track.title} to queue`}
      >
        <Plus size={12} />
        {adding ? "Adding…" : "Add"}
      </button>
    </div>
  );
}
