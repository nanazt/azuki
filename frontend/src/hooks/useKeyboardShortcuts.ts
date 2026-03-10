import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { usePlayerStore } from "../stores/playerStore";
import { usePlayer } from "./usePlayer";

export function useKeyboardShortcuts() {
  const { togglePlay, seek, setVolume, volume } = usePlayer();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active as HTMLElement)?.isContentEditable;

      // "/" works even when not focused on input
      // Use e.code for IME-independent matching (e.g. Korean input mode)
      if (e.key === "/" || e.code === "Slash") {
        if (isInput) return;
        e.preventDefault();
        if (location.pathname === "/search") {
          const input = document.querySelector<HTMLInputElement>(
            "[data-search-input]",
          );
          input?.focus();
        } else {
          navigate("/search");
        }
        return;
      }

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
              const maxMs = ps.track?.duration_ms ?? Infinity;
              seek(Math.min(ps.position_ms + 5000, maxMs));
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
        default:
          // IME-independent matching via physical key code
          if (e.code === "KeyM") {
            setVolume(volume > 0 ? 0 : 5);
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek, setVolume, volume, navigate, location.pathname]);
}
