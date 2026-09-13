import { create } from "zustand";
import type {
  LoopMode,
  PlayStateInfo,
  PlayerSnapshot,
  QueueEntry,
  TrackInfo,
  UserInfo,
} from "../lib/types";

interface PlayerState {
  playState: PlayStateInfo;
  queue: QueueEntry[];
  currentAddedBy: UserInfo | null;

  volume: number;
  loopMode: LoopMode;
  listeners: UserInfo[];
  playbackSuspended: boolean;
  playbackRevision: number;
  liveEventSeq: number;
  snapshotSeq: number;
  connected: boolean;
  hasConnected: boolean;
  boostMode: boolean;

  currentTrack: () => TrackInfo | null;
  isPlaying: () => boolean;

  applySnapshot: (snapshot: PlayerSnapshot, seq?: number) => void;
  setPlayState: (s: PlayStateInfo) => void;
  setQueue: (q: QueueEntry[]) => void;
  setCurrentAddedBy: (u: UserInfo | null) => void;

  setVolume: (v: number) => void;
  setLoopMode: (m: LoopMode) => void;
  setListeners: (l: UserInfo[]) => void;
  setLiveEventSeq: (seq: number) => void;
  setOutputSuspended: (suspended: boolean, positionMs: number) => void;
  setConnected: (c: boolean) => void;
  setBoostMode: (v: boolean) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  playState: { status: "idle" },
  queue: [],
  currentAddedBy: null,

  volume: 5,
  loopMode: "off",
  listeners: [],
  playbackSuspended: false,
  playbackRevision: 0,
  liveEventSeq: 0,
  snapshotSeq: 0,
  connected: false,
  hasConnected: false,
  boostMode: false,

  currentTrack: () => {
    const s = get().playState;
    if (s.status === "idle") return null;
    return s.track;
  },

  isPlaying: () => get().playState.status === "playing",

  applySnapshot: (snapshot, seq) =>
    set({
      playState: snapshot.state,
      queue: snapshot.queue,
      currentAddedBy: snapshot.current_added_by ?? null,

      volume: snapshot.volume,
      loopMode: snapshot.loop_mode,
      listeners: snapshot.listeners,
      playbackSuspended: snapshot.playback_suspended,
      playbackRevision: snapshot.playback_revision,
      snapshotSeq: seq ?? 0,
    }),

  setPlayState: (s) => set({ playState: s }),
  setQueue: (q) => set({ queue: q }),
  setCurrentAddedBy: (u) => set({ currentAddedBy: u }),

  setVolume: (v) => set({ volume: v }),
  setLoopMode: (m) => set({ loopMode: m }),
  setListeners: (l) => set({ listeners: l }),
  setOutputSuspended: (suspended, positionMs) =>
    set((state) => ({
      playbackSuspended: suspended,
      playState:
        state.playState.status === "playing" ||
        state.playState.status === "paused"
          ? { ...state.playState, position_ms: positionMs }
          : state.playState,
    })),
  setLiveEventSeq: (seq) => set({ liveEventSeq: seq }),
  setConnected: (c) =>
    set((prev) => ({ connected: c, hasConnected: prev.hasConnected || c })),
  setBoostMode: (v) => set({ boostMode: v }),
}));
