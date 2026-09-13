import { create } from "zustand";
import type { BotStatus } from "../lib/types";

interface BotState {
  status: BotStatus | null;
  connectionGeneration: number | null;
  lifecycleEpoch: number;
  lastRevision: number | null;

  beginConnection: (connectionGeneration: number) => void;
  endConnection: (connectionGeneration: number) => void;
  applyWebSocketStatus: (
    status: BotStatus,
    connectionGeneration: number,
  ) => void;
  applyHttpStatus: (status: BotStatus, lifecycleEpoch: number) => void;
}


export const useBotStore = create<BotState>((set) => ({
  status: null,
  connectionGeneration: null,
  lifecycleEpoch: 0,
  lastRevision: null,

  beginConnection: (connectionGeneration) =>
    set((state) => ({
      connectionGeneration,
      lifecycleEpoch: state.lifecycleEpoch + 1,
      lastRevision: null,
    })),

  endConnection: (connectionGeneration) =>
    set((state) =>
      state.connectionGeneration === connectionGeneration
        ? {
            connectionGeneration: null,
            lifecycleEpoch: state.lifecycleEpoch + 1,
            lastRevision: null,
          }
        : state,
    ),

  applyWebSocketStatus: (status, connectionGeneration) =>
    set((state) =>
      state.connectionGeneration === connectionGeneration &&
      (state.lastRevision === null || status.revision >= state.lastRevision)
        ? { status, lastRevision: status.revision }
        : state,
    ),

  applyHttpStatus: (status, lifecycleEpoch) =>
    set((state) =>
      state.lifecycleEpoch === lifecycleEpoch &&
      (state.lastRevision === null || status.revision >= state.lastRevision)
        ? { status, lastRevision: status.revision }
        : state,
    ),
}));
