import { useCallback } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { api } from "../lib/api";

export function usePlayer() {
  const playState = usePlayerStore((s) => s.playState);
  const volume = usePlayerStore((s) => s.volume);
  const loopMode = usePlayerStore((s) => s.loopMode);

  const pause = useCallback(() => {
    usePlayerStore.getState().setPlayState(
      playState.status === "playing"
        ? { status: "paused", track: playState.track, position_ms: playState.position_ms }
        : playState,
    );
    api.pause();
  }, [playState]);

  const resume = useCallback(() => {
    usePlayerStore.getState().setPlayState(
      playState.status === "paused"
        ? { status: "playing", track: playState.track, position_ms: playState.position_ms }
        : playState,
    );
    api.resume();
  }, [playState]);

  const togglePlay = useCallback(() => {
    if (playState.status === "playing") pause();
    else if (playState.status === "paused") resume();
  }, [playState, pause, resume]);

  const skip = useCallback(() => api.skip(), []);
  const stop = useCallback(() => api.stop(), []);

  const seek = useCallback((ms: number) => {
    api.seek(ms);
  }, []);

  const setVolume = useCallback((v: number) => {
    usePlayerStore.getState().setVolume(v);
    api.setVolume(v);
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
    stop,
    seek,
    setVolume,
    setLoop,
    cycleLoop,
  };
}
