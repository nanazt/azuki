import { create } from "zustand";
import type { UserInfo } from "../lib/types";

export type DownloadStage = "resolving" | "downloading" | "converting";

export interface DownloadEntry {
  download_id: string;
  query: string;
  stage: DownloadStage;
  percent: number;
  speed_bps: number | null;
  status: "downloading" | "complete" | "failed";
  error?: string;
  track?: any;
  user_info?: UserInfo;
  title?: string;
  artist?: string;
  thumbnail_url?: string;
  duration_ms?: number;
  source_url?: string;
}

interface DownloadState {
  downloads: Map<string, DownloadEntry>;
  startDownload: (id: string, query: string, userInfo?: UserInfo) => void;
  resolveMetadata: (
    id: string,
    meta: {
      title: string;
      artist: string | null;
      thumbnail_url: string | null;
      duration_ms: number;
      source_url: string;
    },
  ) => void;
  updateProgress: (
    id: string,
    stage: DownloadStage,
    percent: number,
    speed_bps: number | null,
  ) => void;
  completeDownload: (id: string, track: any) => void;
  failDownload: (id: string, error: string) => void;
  removeDownload: (id: string) => void;
  activeCount: () => number;
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  downloads: new Map(),

  startDownload: (id, query, userInfo?) =>
    set((state) => {
      const next = new Map(state.downloads);
      next.set(id, {
        download_id: id,
        query,
        stage: "resolving",
        percent: 0,
        speed_bps: null,
        status: "downloading",
        user_info: userInfo,
      });
      return { downloads: next };
    }),

  resolveMetadata: (id, meta) =>
    set((state) => {
      const next = new Map(state.downloads);
      const entry = next.get(id);
      if (entry)
        next.set(id, {
          ...entry,
          title: meta.title,
          artist: meta.artist ?? undefined,
          thumbnail_url: meta.thumbnail_url ?? undefined,
          duration_ms: meta.duration_ms,
          source_url: meta.source_url,
        });
      return { downloads: next };
    }),

  updateProgress: (id, stage, percent, speed_bps) =>
    set((state) => {
      const next = new Map(state.downloads);
      const entry = next.get(id);
      if (entry) next.set(id, { ...entry, stage, percent, speed_bps });
      return { downloads: next };
    }),

  completeDownload: (id, track) =>
    set((state) => {
      const next = new Map(state.downloads);
      const entry = next.get(id);
      if (entry)
        next.set(id, { ...entry, status: "complete", percent: 100, track });
      return { downloads: next };
    }),

  failDownload: (id, error) =>
    set((state) => {
      const next = new Map(state.downloads);
      const entry = next.get(id);
      if (entry) next.set(id, { ...entry, status: "failed", error });
      return { downloads: next };
    }),

  removeDownload: (id) =>
    set((state) => {
      const next = new Map(state.downloads);
      next.delete(id);
      return { downloads: next };
    }),

  activeCount: () => {
    let count = 0;
    for (const entry of get().downloads.values()) {
      if (entry.status === "downloading") count++;
    }
    return count;
  },
}));
