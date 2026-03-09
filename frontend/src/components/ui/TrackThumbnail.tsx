import { useState, useRef, useEffect } from "react";
import { Music } from "lucide-react";
import clsx from "clsx";

interface TrackThumbnailProps {
  track: { id?: string; thumbnail_url?: string | null };
  sizeClass: string;
  iconSize: number;
  className?: string;
  preferExternal?: boolean;
}

type Stage = "local" | "external" | "icon";

export function TrackThumbnail({
  track,
  sizeClass,
  iconSize,
  className,
  preferExternal,
}: TrackThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const localUrl =
    track.id && track.thumbnail_url
      ? `/media/thumbnails/${track.id}.jpg`
      : null;
  const externalUrl = track.thumbnail_url ?? null;
  const initialStage: Stage = preferExternal
    ? externalUrl
      ? "external"
      : localUrl
        ? "local"
        : "icon"
    : localUrl
      ? "local"
      : externalUrl
        ? "external"
        : "icon";

  const [stage, setStage] = useState<Stage>(initialStage);

  useEffect(() => {
    setStage(initialStage);
  }, [track.id, track.thumbnail_url]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const src =
    stage === "local" ? localUrl : stage === "external" ? externalUrl : null;

  if (!visible || !src || stage === "icon") {
    return (
      <div
        ref={containerRef}
        className={clsx(
          sizeClass,
          "bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0",
          className,
        )}
      >
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
        } else if (stage === "external" && localUrl && preferExternal) {
          setStage("local");
        } else {
          setStage("icon");
        }
      }}
    />
  );
}
