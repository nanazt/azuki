import { useEffect, useRef, useState, useCallback } from "react";
import clsx from "clsx";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Volume2,
  VolumeX,
  Repeat,
  Repeat1,
  Heart,
  ChevronUp,
} from "lucide-react";
import { usePlayer } from "../../../hooks/usePlayer";
import { usePlayerStore } from "../../../stores/playerStore";
import { api } from "../../../lib/api";
import { Slider } from "../../ui/Slider";
import { TrackThumbnail } from "../../ui/TrackThumbnail";
import { formatTime } from "../../../lib/utils";

export function PlayerBar() {
  const { playState, volume, loopMode, togglePlay, skip, previous, seek, setVolume, cycleLoop } =
    usePlayer();
  const favoritedTrackIds = usePlayerStore((s) => s.favoritedTrackIds);
  const boostMode = usePlayerStore((s) => s.boostMode);
  const setBoostMode = usePlayerStore((s) => s.setBoostMode);
  const [elapsed, setElapsed] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [volumeSaved, setVolumeSaved] = useState(false);
  const prevVolumeRef = useRef<number>(volume);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const rafRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(Date.now());

  const track =
    playState.status !== "idle" ? playState.track : null;
  const favorited = track ? favoritedTrackIds.has(track.id) : false;
  const connected = usePlayerStore((s) => s.connected);
  const isPlaying = playState.status === "playing";
  const positionMs =
    playState.status === "playing" || playState.status === "paused"
      ? playState.position_ms
      : 0;
  const duration = track?.duration_ms ?? 0;

  // Update elapsed with RAF when playing
  useEffect(() => {
    if (playState.status === "playing" && connected) {
      lastUpdateRef.current = Date.now();
      const basePosition = playState.position_ms;

      const tick = () => {
        const delta = Date.now() - lastUpdateRef.current;
        const newElapsed = Math.min(basePosition + delta, duration);
        setElapsed(newElapsed);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setElapsed(positionMs);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playState, positionMs, duration, connected]);

  const handleSeekStart = useCallback(() => {
    setIsSeeking(true);
    setSeekValue(elapsed);
  }, [elapsed]);

  const handleSeekChange = useCallback((value: number) => {
    setSeekValue(value);
  }, []);

  const handleSeekEnd = useCallback(
    (value: number) => {
      setIsSeeking(false);
      seek(value);
    },
    [seek]
  );

  const handleVolumeChange = useCallback(
    (value: number) => {
      if (value > 0) prevVolumeRef.current = value;
      setVolume(value);
      setVolumeSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setVolumeSaved(false), 1500);
    },
    [setVolume]
  );

  const handleToggleFavorite = useCallback(async () => {
    if (!track) return;
    const isFav = favoritedTrackIds.has(track.id);
    usePlayerStore.getState().toggleFavoritedTrackId(track.id, !isFav);
    try {
      await api.toggleFavorite(track.id);
    } catch {
      usePlayerStore.getState().toggleFavoritedTrackId(track.id, isFav);
    }
  }, [track, favoritedTrackIds]);

  const loopIcon = () => {
    if (loopMode === "one") return <Repeat1 size={16} />;
    return <Repeat size={16} />;
  };

  const loopActive = loopMode !== "off";

  const displayElapsed = isSeeking ? seekValue : elapsed;
  const sliderMax = duration > 0 ? duration : 1;

  const effectiveBoost = boostMode || volume > 10;
  const volumeSliderMax = effectiveBoost ? 100 : 10;

  if (!track) {
    return (
      <div className="h-[80px] flex items-center justify-center bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)]">
        <span className="text-[var(--color-text-tertiary)] text-sm">
          Nothing playing
        </span>
      </div>
    );
  }

  return (
    <>
      {/* Desktop layout */}
      <div className="hidden md:flex flex-col bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] px-4 py-2 gap-1">
        {/* Row 1 */}
        <div className="flex items-center gap-4">
          {/* Left: track info */}
          <div className="flex items-center gap-3 min-w-0 w-[30%]">
            <TrackThumbnail track={track} sizeClass="w-12 h-12" iconSize={20} className="rounded" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)] truncate">
                {track.title}
              </div>
              {track.artist && (
                <div className="text-xs text-[var(--color-text-secondary)] truncate">
                  {track.artist}
                </div>
              )}
            </div>
            <button
              onClick={handleToggleFavorite}
              className={clsx(
                "flex-shrink-0 p-1.5 rounded-full transition-colors duration-150 cursor-pointer",
                favorited
                  ? "text-[var(--color-danger)]"
                  : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]"
              )}
              aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
            >
              <Heart size={16} fill={favorited ? "currentColor" : "none"} />
            </button>
          </div>

          {/* Center: controls */}
          <div className="flex items-center gap-2 justify-center flex-1">
            <button
              onClick={previous}
              className="p-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors cursor-pointer rounded-full hover:bg-[var(--color-bg-hover)]"
              aria-label="Previous"
            >
              <SkipBack size={18} />
            </button>
            <button
              onClick={togglePlay}
              className="p-2.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-full transition-colors cursor-pointer"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" />}
            </button>
            <button
              onClick={skip}
              className="p-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors cursor-pointer rounded-full hover:bg-[var(--color-bg-hover)]"
              aria-label="Skip"
            >
              <SkipForward size={18} />
            </button>
            <button
              onClick={cycleLoop}
              className={clsx(
                "p-2 rounded-full transition-colors cursor-pointer",
                loopActive
                  ? "text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
              )}
              aria-label={`Loop: ${loopMode}`}
            >
              {loopIcon()}
            </button>
          </div>

          {/* Right: volume + toggles */}
          <div className="flex items-center gap-3 justify-end w-[30%]">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (volume > 0) {
                    prevVolumeRef.current = volume;
                    setVolume(0);
                  } else {
                    setVolume(prevVolumeRef.current || 5);
                  }
                }}
                className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
                aria-label={volume === 0 ? "Unmute" : "Mute"}
              >
                {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <Slider
                value={volume}
                min={0}
                max={volumeSliderMax}
                onChange={handleVolumeChange}
                className="w-24"
                aria-label="Volume"
              />
              <span className={clsx(
                "text-xs tabular-nums w-7 text-right select-none transition-colors duration-300",
                volumeSaved ? "text-[var(--color-success)]" : "text-[var(--color-text-tertiary)]"
              )}>
                {volume}%
              </span>
              <button
                onClick={() => {
                  if (volume <= 10) setBoostMode(!boostMode);
                }}
                disabled={volume > 10}
                className={clsx(
                  "p-1 rounded transition-colors",
                  volume > 10
                    ? "text-[var(--color-accent)] cursor-default"
                    : effectiveBoost
                      ? "text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] cursor-pointer"
                      : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] cursor-pointer"
                )}
                aria-label={effectiveBoost ? "Disable volume boost" : "Enable volume boost"}
                title={effectiveBoost ? "Volume boost on (0-100%)" : "Volume boost off (0-10%)"}
              >
                <ChevronUp size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* Row 2: seek bar */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-tertiary)] w-10 text-right tabular-nums">
            {formatTime(displayElapsed)}
          </span>
          <Slider
            value={isSeeking ? seekValue : displayElapsed}
            min={0}
            max={sliderMax}
            onChange={(v) => {
              if (!isSeeking) handleSeekStart();
              handleSeekChange(v);
            }}
            onChangeEnd={handleSeekEnd}
            className="flex-1"
            aria-label="Seek"
          />
          <span className="text-xs text-[var(--color-text-tertiary)] w-10 tabular-nums">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Mobile mini player */}
      <div className="flex md:hidden items-center gap-3 h-[60px] bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] px-3">
        <TrackThumbnail track={track} sizeClass="w-10 h-10" iconSize={16} className="rounded" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-text)] truncate">
            {track.title}
          </div>
          {track.artist && (
            <div className="text-xs text-[var(--color-text-secondary)] truncate">
              {track.artist}
            </div>
          )}
        </div>
        <button
          onClick={togglePlay}
          className="min-w-11 min-h-11 flex items-center justify-center text-[var(--color-text)] cursor-pointer touch-manipulation"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button
          onClick={skip}
          className="min-w-11 min-h-11 flex items-center justify-center text-[var(--color-text-secondary)] cursor-pointer touch-manipulation"
          aria-label="Skip"
        >
          <SkipForward size={20} />
        </button>
      </div>
    </>
  );
}
