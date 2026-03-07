import { useCallback, useRef } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { api } from "../lib/api";

export function usePlayer() {
  const playState = usePlayerStore((s) => s.playState);
  const volume = usePlayerStore((s) => s.volume);
  const loopMode = usePlayerStore((s) => s.loopMode);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pause = useCallback(() => {
    const s = usePlayerStore.getState();
    if (s.playState.status === "playing") {
      s.setPlayState({
        status: "paused",
        track: s.playState.track,
        position_ms: s.playState.position_ms,
      });
    }
    api.pause();
  }, []);

  const resume = useCallback(() => {
    const s = usePlayerStore.getState();
    if (s.playState.status === "paused") {
      s.setPlayState({
        status: "playing",
        track: s.playState.track,
        position_ms: s.playState.position_ms,
      });
    }
    api.resume();
  }, []);

  const togglePlay = useCallback(() => {
    const status = usePlayerStore.getState().playState.status;
    if (status === "playing") pause();
    else if (status === "paused") resume();
  }, [pause, resume]);

  const skip = useCallback(() => api.skip(), []);
  const previous = useCallback(() => api.previous(), []);
  const stop = useCallback(() => api.stop(), []);

  const seek = useCallback((ms: number) => {
    const s = usePlayerStore.getState();
    if (s.playState.status === "playing" || s.playState.status === "paused") {
      s.setPlayState({ ...s.playState, position_ms: ms });
    }
    api.seek(ms);
  }, []);

  const setVolume = useCallback((v: number) => {
    usePlayerStore.getState().setVolume(v);
    if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
    volumeDebounceRef.current = setTimeout(() => {
      api.setVolume(v);
    }, 150);
  }, []);

  const setLoop = useCallback((mode: "off" | "one" | "all") => {
    usePlayerStore.getState().setLoopMode(mode);
    api.setLoop(mode);
  }, []);

  const cycleLoop = useCallback(() => {
    const next = loopMode === "off" ? "all" : loopMode === "all" ? "one" : "off";
    setLoop(next);
  }, [loopMode, setLoop]);

  return {
    playState,
    volume,
    loopMode,
    pause,
    resume,
    togglePlay,
    skip,
    previous,
    stop,
    seek,
    setVolume,
    setLoop,
    cycleLoop,
  };
}
