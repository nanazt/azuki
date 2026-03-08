import { useEffect } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { usePlayer } from "./usePlayer";

export function useKeyboardShortcuts() {
  const { togglePlay, seek, setVolume, volume } = usePlayer();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active as HTMLElement)?.isContentEditable;

      if (isInput) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          {
            const ps = usePlayerStore.getState().playState;
            if (ps.status === "playing" || ps.status === "paused") {
              seek(Math.max(0, ps.position_ms - 5000));
            }
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          {
            const ps = usePlayerStore.getState().playState;
            if (ps.status === "playing" || ps.status === "paused") {
              seek(ps.position_ms + 5000);
            }
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(Math.min(100, volume + 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(Math.max(0, volume - 1));
          break;
        case "m":
        case "M":
          setVolume(volume > 0 ? 0 : 5);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek, setVolume, volume]);
}
