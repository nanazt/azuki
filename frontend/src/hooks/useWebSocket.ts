import { useEffect, useRef, useCallback } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useDownloadStore } from "../stores/downloadStore";
import type { SeqEvent } from "../lib/types";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retriesRef = useRef(0);

  const store = usePlayerStore;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      store.getState().setConnected(true);
      retriesRef.current = 0;
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleEvent(data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      store.getState().setConnected(false);
      wsRef.current = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
    retriesRef.current++;
    reconnectTimer.current = setTimeout(connect, delay);
  }, [connect]);

  const restoreActiveDownloads = (downloads?: { download_id: string; query: string; percent: number; speed_bps: number | null }[]) => {
    if (!downloads?.length) return;
    const dlStore = useDownloadStore.getState();
    for (const dl of downloads) {
      dlStore.startDownload(dl.download_id, dl.query);
      if (dl.percent > 0) dlStore.updateProgress(dl.download_id, "downloading", dl.percent, dl.speed_bps);
    }
  };

  const handleEvent = (data: SeqEvent | { event: { type: "state_snapshot" } }) => {
    const state = store.getState();

    // Initial snapshot (no seq wrapper)
    if ("type" in data && (data as any).type === "state_snapshot") {
      const snap = data as any;
      state.applySnapshot(snap.state ?? snap);
      restoreActiveDownloads(snap.active_downloads);
      return;
    }

    const seqEvent = data as SeqEvent;
    if (seqEvent.seq && seqEvent.seq <= state.lastSeq) return;
    if (seqEvent.seq) state.setLastSeq(seqEvent.seq);

    const event = seqEvent.event ?? data;
    const ev = event as any;

    switch (ev.type) {
      case "state_snapshot":
        state.applySnapshot(ev.state, seqEvent.seq);
        restoreActiveDownloads(ev.active_downloads);
        break;
      case "track_started":
        state.setPlayState({ status: "playing", track: ev.track, position_ms: ev.position_ms });
        break;
      case "track_loading":
        state.setPlayState({ status: "loading", track: ev.track });
        break;
      case "track_ended":
        state.setPlayState({ status: "idle" });
        break;
      case "track_error":
        if (state.playState.status !== "idle") {
          state.setPlayState({
            status: "error",
            track: (state.playState as any).track,
            error: ev.error,
          });
        }
        break;
      case "paused":
        if (state.playState.status === "playing") {
          state.setPlayState({
            status: "paused",
            track: state.playState.track,
            position_ms: ev.position_ms,
          });
        }
        break;
      case "resumed":
        if (state.playState.status === "paused") {
          state.setPlayState({
            status: "playing",
            track: state.playState.track,
            position_ms: ev.position_ms,
          });
        }
        break;
      case "seeked":
        if (state.playState.status === "playing") {
          state.setPlayState({ ...state.playState, position_ms: ev.position_ms });
        } else if (state.playState.status === "paused") {
          state.setPlayState({ ...state.playState, position_ms: ev.position_ms });
        }
        break;
      case "volume_changed":
        state.setVolume(ev.volume);
        break;
      case "queue_updated":
        state.setQueue(ev.queue);
        break;
      case "loop_mode_changed":
        state.setLoopMode(ev.mode);
        break;
      case "listeners_updated":
        state.setListeners(ev.users);
        break;
      case "favorite_changed":
        state.toggleFavoritedTrackId(ev.track_id, ev.favorited);
        window.dispatchEvent(new CustomEvent("favorite-changed", { detail: { track_id: ev.track_id, user_id: ev.user_id, favorited: ev.favorited } }));
        break;
      case "video_sync":
        // Video sync handled by VideoPlayer component via playerStore
        break;
      case "playlist_updated":
        window.dispatchEvent(new CustomEvent("playlist-updated", { detail: { playlist_id: ev.playlist_id } }));
        break;
      case "history_added":
        window.dispatchEvent(new CustomEvent("history-added", { detail: { track: ev.track, user_id: ev.user_id } }));
        break;
      case "download_started":
        useDownloadStore.getState().startDownload(ev.download_id, ev.query);
        break;
      case "download_progress":
        useDownloadStore.getState().updateProgress(ev.download_id, ev.stage ?? "downloading", ev.percent, ev.speed_bps);
        break;
      case "download_complete":
        useDownloadStore.getState().completeDownload(ev.download_id, ev.track);
        setTimeout(() => useDownloadStore.getState().removeDownload(ev.download_id), 3000);
        break;
      case "download_failed":
        useDownloadStore.getState().failDownload(ev.download_id, ev.error);
        break;
    }
  };

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { send };
}
