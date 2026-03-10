import { Plus, Check } from "lucide-react";
import { TrackThumbnail } from "../../ui/TrackThumbnail";
import clsx from "clsx";
import type { TrackInfo } from "../../../lib/types";
import { formatTime } from "../../../lib/utils";
import { useLocale, t } from "../../../hooks/useLocale";

interface SearchResultProps {
  track: TrackInfo;
  onAdd: (track: TrackInfo) => void;
  adding?: boolean;
  added?: boolean;
}

export function SearchResult({
  track,
  onAdd,
  adding = false,
  added = false,
}: SearchResultProps) {
  useLocale();
  const s = t();
  return (
    <div
      className={clsx(
        "flex items-center gap-3 px-3 py-2 rounded-lg",
        "hover:bg-[var(--color-bg-hover)] transition-colors duration-100 group",
      )}
    >
      <TrackThumbnail
        track={track}
        sizeClass="w-12 h-12"
        iconSize={18}
        className="rounded"
        preferExternal
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--color-text)] truncate">
          {track.title}
        </div>
        <div className="text-xs text-[var(--color-text-secondary)] truncate">
          {track.artist ?? s.common.unknownArtist}
          {track.duration_ms > 0 && (
            <span className="text-[var(--color-text-tertiary)] ml-2">
              {formatTime(track.duration_ms)}
            </span>
          )}
        </div>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={adding || added}
        className={clsx(
          "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium",
          "transition-[color,background-color,opacity] duration-150 cursor-pointer",
          added
            ? "bg-[var(--color-bg-tertiary)] text-[var(--color-success)] cursor-default"
            : adding
              ? "bg-[var(--color-accent)] text-[#1a1a1a] cursor-not-allowed opacity-0 group-hover:opacity-100"
              : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[#1a1a1a] opacity-0 group-hover:opacity-100",
        )}
        aria-label={`Add ${track.title} to queue`}
      >
        <span className="relative w-3 h-3 flex-shrink-0">
          <Plus
            size={12}
            className={clsx(
              "absolute inset-0 transition-[opacity,transform] duration-150",
              added ? "opacity-0 scale-75" : "opacity-100 scale-100",
            )}
          />
          <Check
            size={12}
            className={clsx(
              "absolute inset-0 transition-[opacity,transform] duration-150",
              added ? "opacity-100 scale-100" : "opacity-0 scale-75",
            )}
          />
        </span>
        {s.history.add}
      </button>
    </div>
  );
}
