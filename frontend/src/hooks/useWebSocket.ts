import { useEffect, useRef, useCallback } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useDownloadStore } from "../stores/downloadStore";
import {
  recoverAuthentication,
  useAuthStore,
  waitForPendingRefresh,
} from "../stores/authStore";
import type { AuthStatus } from "../stores/authStore";
import { useToast } from "./useToast";
import { t } from "./useLocale";
import type { DownloadStatus, SeqEvent } from "../lib/types";

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retriesRef = useRef(0);
  const syncDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lifecycleGenerationRef = useRef(0);
  const socketGenerationRef = useRef(0);
  const status = useAuthStore((state) => state.status);
  const loggingOut = useAuthStore((state) => state.loggingOut);
  const { showToast } = useToast();
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const store = usePlayerStore;

  const restoreActiveDownloads = (downloads?: DownloadStatus[]) => {
    if (!downloads?.length) return;
    const dlStore = useDownloadStore.getState();
    for (const dl of downloads) {
      dlStore.startDownload(
        dl.download_id,
        dl.query,
        dl.user_info ?? undefined,
      );
      if (dl.title) {
        dlStore.resolveMetadata(dl.download_id, {
          title: dl.title,
          artist: dl.artist ?? null,
          thumbnail_url: dl.thumbnail_url ?? null,
          duration_ms: dl.duration_ms ?? 0,
          source_url: dl.source_url ?? "",
        });
      }
      if (dl.percent > 0)
        dlStore.updateProgress(
          dl.download_id,
          "downloading",
          dl.percent,
          dl.speed_bps,
        );
    }
  };

  const handleEvent = (
    data: SeqEvent | { event: { type: "state_snapshot" } },
  ) => {
    const state = store.getState();

    // Initial snapshot (no seq wrapper)
    if ("type" in data && (data as any).type === "state_snapshot") {
      const snap = data as any;
      state.applySnapshot(snap.state ?? snap, 0);
      restoreActiveDownloads(snap.active_downloads);
      return;
    }

    const seqEvent = data as SeqEvent;
    if (
      seqEvent.seq != null &&
      seqEvent.seq > 0 &&
      seqEvent.seq <= state.lastSeq
    )
      return;
    if (seqEvent.seq != null && seqEvent.seq > 0)
      state.setLastSeq(seqEvent.seq);

    const event = seqEvent.event ?? data;
    const ev = event as any;

    switch (ev.type) {
      case "state_snapshot":
        state.applySnapshot(ev.state, seqEvent.seq);
        restoreActiveDownloads(ev.active_downloads);
        break;
      case "track_started":
        state.setPlayState({
          status: ev.paused ? "paused" : "playing",
          track: ev.track,
          position_ms: ev.position_ms,
        });
        state.setCurrentAddedBy(ev.added_by ?? null);
        break;
      case "track_loading":
        state.setPlayState({ status: "loading", track: ev.track });
        break;
      case "track_ended":
        // Backend sends TrackStarted after TrackEnded when queue has items or loopMode is "one" (replay).
        // Only set idle when truly stopping: empty queue AND not in single-track loop.
        if (state.queue.length === 0 && state.loopMode !== "one") {
          state.setPlayState({ status: "idle" });
          state.setCurrentAddedBy(null);
        }
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
        if (
          state.playState.status === "playing" ||
          state.playState.status === "paused"
        ) {
          state.setPlayState({
            status: "paused",
            track: state.playState.track,
            position_ms: ev.position_ms,
          });
        }
        break;
      case "resumed":
        if (
          state.playState.status === "paused" ||
          state.playState.status === "playing"
        ) {
          state.setPlayState({
            status: "playing",
            track: state.playState.track,
            position_ms: ev.position_ms,
          });
        }
        break;
      case "seeked":
        if (state.playState.status === "playing") {
          state.setPlayState({
            ...state.playState,
            position_ms: ev.position_ms,
          });
        } else if (state.playState.status === "paused") {
          state.setPlayState({
            ...state.playState,
            position_ms: ev.position_ms,
          });
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
      case "video_sync":
        // Video sync handled by VideoPlayer component via playerStore
        break;
      case "history_added":
        window.dispatchEvent(
          new CustomEvent("history-added", {
            detail: { track: ev.track, user_id: ev.user_id },
          }),
        );
        break;
      case "history_updated":
        break;
      case "upload_added":
        window.dispatchEvent(
          new CustomEvent("upload-added", {
            detail: { track: ev.track, user_id: ev.user_id },
          }),
        );
        break;
      case "download_started":
        useDownloadStore
          .getState()
          .startDownload(ev.download_id, ev.query, ev.user_info);
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
        useDownloadStore
          .getState()
          .updateProgress(
            ev.download_id,
            ev.stage ?? "downloading",
            ev.percent,
            ev.speed_bps,
          );
        break;
      case "download_complete":
        useDownloadStore.getState().completeDownload(ev.download_id, ev.track);

        setTimeout(
          () => useDownloadStore.getState().removeDownload(ev.download_id),
          3000,
        );
        break;
      case "download_failed":
        useDownloadStore.getState().failDownload(ev.download_id, ev.error);
        showToastRef.current(ev.error ?? t().toast.failedToAddToQueue, "error");
        setTimeout(
          () => useDownloadStore.getState().removeDownload(ev.download_id),
          3000,
        );
        break;
    }
  };

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || loggingOut) {
      store.getState().setConnected(false);
      return;
    }

    const lifecycleGeneration = ++lifecycleGenerationRef.current;
    let disposed = false;
    let connectInFlight: Promise<void> | null = null;
    let authRecoveryInFlight: Promise<AuthStatus> | null = null;

    const lifecycleIsCurrent = () =>
      !disposed &&
      lifecycleGenerationRef.current === lifecycleGeneration &&
      useAuthStore.getState().status === "authenticated" &&
      !useAuthStore.getState().loggingOut;

    const socketIsCurrent = (socket: WebSocket, socketGeneration: number) =>
      lifecycleIsCurrent() &&
      socketGenerationRef.current === socketGeneration &&
      wsRef.current === socket;

    const scheduleReconnect = () => {
      if (!lifecycleIsCurrent()) return;

      clearTimeout(reconnectTimer.current);
      const scheduledLifecycle = lifecycleGeneration;
      const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
      retriesRef.current += 1;
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = undefined;
        if (
          !lifecycleIsCurrent() ||
          lifecycleGenerationRef.current !== scheduledLifecycle
        ) {
          return;
        }
        void connect();
      }, delay);
    };

    const reconnectAfterAuthenticationCheck = async (
      closedSocketGeneration: number,
    ) => {
      const operation = recoverAuthentication();
      authRecoveryInFlight = operation;

      try {
        const authStatus = await operation;
        if (
          !lifecycleIsCurrent() ||
          socketGenerationRef.current !== closedSocketGeneration
        ) {
          return;
        }
        if (authStatus === "authenticated") {
          scheduleReconnect();
        }
      } finally {
        if (authRecoveryInFlight === operation) {
          authRecoveryInFlight = null;
        }
      }
    };

    const connect = (): Promise<void> => {
      if (connectInFlight) return connectInFlight;

      const operation = (async () => {
        if (authRecoveryInFlight) {
          await authRecoveryInFlight;
          return;
        }
        await waitForPendingRefresh();
        if (!lifecycleIsCurrent()) return;

        const currentSocket = wsRef.current;
        if (
          currentSocket &&
          (currentSocket.readyState === WebSocket.CONNECTING ||
            currentSocket.readyState === WebSocket.OPEN)
        ) {
          return;
        }

        const protocol =
          window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${protocol}//${window.location.host}/ws`,
        );
        const socketGeneration = ++socketGenerationRef.current;
        let opened = false;
        wsRef.current = socket;

        socket.onopen = () => {
          if (!socketIsCurrent(socket, socketGeneration)) return;
          opened = true;
          store.getState().setConnected(true);
          retriesRef.current = 0;
        };

        socket.onmessage = (event) => {
          if (!socketIsCurrent(socket, socketGeneration)) return;
          try {
            clearTimeout(syncTimeoutRef.current);
            const data = JSON.parse(event.data);
            handleEvent(data);
          } catch {
            // Ignore malformed messages.
          }
        };

        socket.onerror = () => {
          if (!socketIsCurrent(socket, socketGeneration)) return;
          socket.close();
        };

        socket.onclose = (event) => {
          if (!socketIsCurrent(socket, socketGeneration)) return;

          store.getState().setConnected(false);
          wsRef.current = null;
          clearTimeout(syncTimeoutRef.current);

          if (!lifecycleIsCurrent()) return;

          if (event.code === 4001 || event.code === 1006 || !opened) {
            void reconnectAfterAuthenticationCheck(socketGeneration);
            return;
          }

          scheduleReconnect();
        };
      })();

      connectInFlight = operation;
      void operation.finally(() => {
        if (connectInFlight === operation) {
          connectInFlight = null;
        }
      });
      return operation;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !lifecycleIsCurrent()) {
        return;
      }

      clearTimeout(syncDebounceRef.current);
      const scheduledLifecycle = lifecycleGeneration;
      syncDebounceRef.current = setTimeout(() => {
        syncDebounceRef.current = undefined;
        if (
          !lifecycleIsCurrent() ||
          lifecycleGenerationRef.current !== scheduledLifecycle
        ) {
          return;
        }

        const socket = wsRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          const socketGeneration = socketGenerationRef.current;
          socket.send(JSON.stringify({ action: "sync" }));

          clearTimeout(syncTimeoutRef.current);
          syncTimeoutRef.current = setTimeout(() => {
            syncTimeoutRef.current = undefined;
            if (socketIsCurrent(socket, socketGeneration)) {
              socket.close();
            }
          }, 5000);
        } else if (!socket || socket.readyState === WebSocket.CLOSED) {
          retriesRef.current = 0;
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = undefined;
          void connect();
        }
      }, 250);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void connect();

    return () => {
      disposed = true;
      ++lifecycleGenerationRef.current;
      ++socketGenerationRef.current;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(syncDebounceRef.current);
      clearTimeout(syncTimeoutRef.current);
      clearTimeout(reconnectTimer.current);
      syncDebounceRef.current = undefined;
      syncTimeoutRef.current = undefined;
      reconnectTimer.current = undefined;

      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
      store.getState().setConnected(false);
    };
  }, [loggingOut, status]);

  return { send };
}
