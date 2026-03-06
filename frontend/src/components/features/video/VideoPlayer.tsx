import { usePlayerStore } from "../../../stores/playerStore";

export function VideoPlayer() {
  const playState = usePlayerStore((s) => s.playState);

  const youtubeId =
    playState.status !== "idle" ? playState.track.youtube_id : null;

  const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

  if (!youtubeId || !YOUTUBE_ID_RE.test(youtubeId)) {
    return (
      <div className="flex items-center justify-center w-full aspect-video bg-[var(--color-bg-secondary)] rounded-lg text-[var(--color-text-tertiary)] text-sm">
        No video available
      </div>
    );
  }

  const embedUrl = `https://www.youtube.com/embed/${youtubeId}?controls=0&modestbranding=1&rel=0&playsinline=1`;

  return (
    <div className="w-full aspect-video rounded-lg overflow-hidden bg-black">
      <iframe
        src={embedUrl}
        title="YouTube video player"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
        referrerPolicy="no-referrer"
        allowFullScreen
        className="w-full h-full border-0"
      />
    </div>
  );
}
