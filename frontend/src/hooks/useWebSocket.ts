import { useEffect, useRef, useCallback } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useImportStore } from "../stores/importStore";
import { useToast } from "./useToast";
import type { SeqEvent } from "../lib/types";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retriesRef = useRef(0);
  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

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
    const delay = 1000;
    retriesRef.current++;
    reconnectTimer.current = setTimeout(connect, delay);
  }, [connect]);

  const restoreActiveDownloads = (downloads?: import("../lib/types").DownloadStatus[]) => {
    if (!downloads?.length) return;
    const dlStore = useDownloadStore.getState();
    for (const dl of downloads) {
      dlStore.startDownload(dl.download_id, dl.query, dl.user_info ?? undefined);
      if (dl.title) {
        dlStore.resolveMetadata(dl.download_id, {
          title: dl.title,
          artist: dl.artist ?? null,
          thumbnail_url: dl.thumbnail_url ?? null,
          duration_ms: dl.duration_ms ?? 0,
          source_url: dl.source_url ?? "",
        });
      }
      if (dl.percent > 0) dlStore.updateProgress(dl.download_id, "downloading", dl.percent, dl.speed_bps);
    }
  };

  const handleEvent = (data: SeqEvent | { event: { type: "state_snapshot" } }) => {
    const state = store.getState();

    // Initial snapshot (no seq wrapper)
    if ("type" in data && (data as any).type === "state_snapshot") {
      const snap = data as any;
      state.applySnapshot(snap.state ?? snap, 0);
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
        state.setCurrentAddedBy(ev.added_by ?? null);
        break;
      case "track_loading":
        state.setPlayState({ status: "loading", track: ev.track });
        break;
      case "track_ended":
        state.setPlayState({ status: "idle" });
        state.setCurrentAddedBy(null);
        window.dispatchEvent(new CustomEvent("track-ended"));
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
        if (state.playState.status === "playing" || state.playState.status === "paused") {
          state.setPlayState({
            status: "paused",
            track: state.playState.track,
            position_ms: ev.position_ms,
          });
        }
        break;
      case "resumed":
        if (state.playState.status === "paused" || state.playState.status === "playing") {
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
        if (ev.slot_id === undefined || ev.slot_id === state.activeSlot) {
          state.setQueue(ev.queue);
        }
        break;
      case "loop_mode_changed":
        state.setLoopMode(ev.mode);
        break;
      case "listeners_updated":
        state.setListeners(ev.users);
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
      case "history_updated":
        break;
      case "download_started":
        useDownloadStore.getState().startDownload(ev.download_id, ev.query, ev.user_info);
        break;
      case "download_metadata_resolved":
        useDownloadStore.getState().resolveMetadata(ev.download_id, {
          title: ev.title,
          artist: ev.artist,
          thumbnail_url: ev.thumbnail_url,
          duration_ms: ev.duration_ms,
          source_url: ev.source_url,
        });
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
        showToastRef.current(ev.error ?? "Failed to add to queue", "error");
        setTimeout(() => useDownloadStore.getState().removeDownload(ev.download_id), 3000);
        break;
      case "queue_slot_created":
        window.dispatchEvent(new CustomEvent("queue-slots-changed"));
        break;
      case "queue_slot_deleted":
        window.dispatchEvent(new CustomEvent("queue-slots-changed"));
        break;
      case "queue_switched": {
        state.setActiveSlot(ev.slot_id);
        window.dispatchEvent(new CustomEvent("queue-slots-changed"));
        break;
      }
      case "queue_slot_exhausted":
        showToastRef.current("Playlist queue finished — slot released", "info");
        window.dispatchEvent(new CustomEvent("queue-slots-changed"));
        break;
      case "multi_queue_state":
        state.setQueueSlots(ev.slots);
        break;
      case "playlist_import_progress":
        useImportStore.getState().setImportProgress(ev.fetched, ev.total);
        break;
      case "playlist_import_complete":
        useImportStore.getState().completeImport(ev.playlist_id, ev.track_count);
        break;
      case "playlist_import_failed":
        useImportStore.getState().failImport(ev.error);
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
