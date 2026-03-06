import { useEffect } from "react";
import { usePlayer } from "./usePlayer";

export function useKeyboardShortcuts() {
  const { togglePlay, seek, setVolume, volume, playState } = usePlayer();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
          if (playState.status === "playing" || playState.status === "paused") {
            seek(Math.max(0, playState.position_ms - 5000));
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (playState.status === "playing" || playState.status === "paused") {
            seek(playState.position_ms + 5000);
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(Math.min(100, volume + 5));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(Math.max(0, volume - 5));
          break;
        case "m":
        case "M":
          setVolume(volume > 0 ? 0 : 50);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek, setVolume, volume, playState]);
}
