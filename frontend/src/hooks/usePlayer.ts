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
      api.pause().catch(() => {});
    }
  }, []);

  const resume = useCallback(() => {
    const s = usePlayerStore.getState();
    if (s.playState.status === "paused") {
      s.setPlayState({
        status: "playing",
        track: s.playState.track,
        position_ms: s.playState.position_ms,
      });
      api.resume().catch(() => {});
    }
  }, []);

  const togglePlay = useCallback(() => {
    const status = usePlayerStore.getState().playState.status;
    if (status === "playing") pause();
    else if (status === "paused") resume();
  }, [pause, resume]);

  const skip = useCallback(() => api.skip().catch(() => {}), []);
  const previous = useCallback(() => api.previous().catch(() => {}), []);

  const seek = useCallback((ms: number) => {
    const s = usePlayerStore.getState();
    if (s.playState.status === "playing" || s.playState.status === "paused") {
      s.setPlayState({ ...s.playState, position_ms: ms });
    }
    api.seek(ms).catch(() => {});
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
    api.setLoop(mode).catch(() => {});
  }, []);

  const cycleLoop = useCallback(() => {
    const next =
      loopMode === "off" ? "all" : loopMode === "all" ? "one" : "off";
    setLoop(next);
  }, [loopMode, setLoop]);

  const moveInQueue = useCallback((from: number, to: number) => {
    const s = usePlayerStore.getState();
    const prevQueue = s.queue;
    const newQueue = [...s.queue];
    const [moved] = newQueue.splice(from, 1);
    newQueue.splice(to, 0, moved);
    s.setQueue(newQueue);
    api.moveInQueue(from, to).catch(() => {
      usePlayerStore.getState().setQueue(prevQueue);
    });
  }, []);

  const playAt = useCallback((position: number) => {
    const s = usePlayerStore.getState();
    const prevQueue = s.queue;
    const prevPlayState = s.playState;
    const entry = s.queue[position];
    if (entry) {
      const newQueue = [...s.queue];
      newQueue.splice(position, 1);
      s.setQueue(newQueue);
      s.setPlayState({
        status: "playing",
        track: entry.track,
        position_ms: 0,
      });
    }
    return api.playAt(position).catch((err) => {
      usePlayerStore.getState().setQueue(prevQueue);
      usePlayerStore.getState().setPlayState(prevPlayState);
      throw err;
    });
  }, []);

  return {
    playState,
    volume,
    loopMode,
    pause,
    resume,
    togglePlay,
    skip,
    previous,
    seek,
    setVolume,
    setLoop,
    cycleLoop,
    moveInQueue,
    playAt,
  };
}
