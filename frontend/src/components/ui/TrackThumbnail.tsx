import { useState } from "react";
import { Music } from "lucide-react";
import clsx from "clsx";

interface TrackThumbnailProps {
  track: { id?: string; thumbnail_url?: string | null };
  sizeClass: string;
  iconSize: number;
  className?: string;
}

type Stage = "local" | "external" | "icon";

export function TrackThumbnail({ track, sizeClass, iconSize, className }: TrackThumbnailProps) {
  const localUrl = track.id && track.thumbnail_url ? `/media/thumbnails/${track.id}.jpg` : null;
  const externalUrl = track.thumbnail_url ?? null;
  const initialStage: Stage = localUrl ? "local" : externalUrl ? "external" : "icon";

  const [stage, setStage] = useState<Stage>(initialStage);

  const src =
    stage === "local" ? localUrl :
    stage === "external" ? externalUrl :
    null;

  if (!src || stage === "icon") {
    return (
      <div className={clsx(sizeClass, "bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0", className)}>
        <Music size={iconSize} className="text-[var(--color-text-tertiary)]" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={clsx(sizeClass, "object-cover flex-shrink-0", className)}
      onError={() => {
        if (stage === "local" && externalUrl) {
          setStage("external");
        } else {
          setStage("icon");
        }
      }}
    />
  );
}
