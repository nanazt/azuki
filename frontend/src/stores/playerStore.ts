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
  volume: number;
  loopMode: LoopMode;
  listeners: UserInfo[];
  lastSeq: number;
  connected: boolean;
  favoritedTrackIds: Set<string>;

  currentTrack: () => TrackInfo | null;
  isPlaying: () => boolean;

  applySnapshot: (snapshot: PlayerSnapshot, seq?: number) => void;
  setPlayState: (s: PlayStateInfo) => void;
  setQueue: (q: QueueEntry[]) => void;
  setVolume: (v: number) => void;
  setLoopMode: (m: LoopMode) => void;
  setListeners: (l: UserInfo[]) => void;
  setLastSeq: (s: number) => void;
  setConnected: (c: boolean) => void;
  setFavoritedTrackIds: (ids: Set<string>) => void;
  toggleFavoritedTrackId: (id: string, favorited: boolean) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  playState: { status: "idle" },
  queue: [],
  volume: 5,
  loopMode: "off",
  listeners: [],
  lastSeq: 0,
  connected: false,
  favoritedTrackIds: new Set(),

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
      volume: snapshot.volume,
      loopMode: snapshot.loop_mode,
      listeners: snapshot.listeners,
      favoritedTrackIds: new Set(snapshot.favorited_track_ids ?? []),
      ...(seq != null ? { lastSeq: seq } : {}),
    }),

  setPlayState: (s) => set({ playState: s }),
  setQueue: (q) => set({ queue: q }),
  setVolume: (v) => set({ volume: v }),
  setLoopMode: (m) => set({ loopMode: m }),
  setListeners: (l) => set({ listeners: l }),
  setLastSeq: (s) => set({ lastSeq: s }),
  setConnected: (c) => set({ connected: c }),
  setFavoritedTrackIds: (ids) => set({ favoritedTrackIds: ids }),
  toggleFavoritedTrackId: (id, favorited) =>
    set((state) => {
      const next = new Set(state.favoritedTrackIds);
      if (favorited) next.add(id);
      else next.delete(id);
      return { favoritedTrackIds: next };
    }),
}));
