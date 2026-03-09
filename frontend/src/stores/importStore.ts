import { create } from "zustand";

export interface ImportProgress {
  playlistId: number | null;
  fetched: number;
  total: number | null;
  error?: string;
  complete: boolean;
}

interface ImportState {
  activeImport: ImportProgress | null;
  setImportProgress: (fetched: number, total: number | null) => void;
  startImport: (playlistId?: number) => void;
  completeImport: (playlistId: number, trackCount: number) => void;
  failImport: (error: string) => void;
  clearImport: () => void;
}

export const useImportStore = create<ImportState>((set) => ({
  activeImport: null,
  startImport: (playlistId) =>
    set({ activeImport: { playlistId: playlistId ?? null, fetched: 0, total: null, complete: false } }),
  setImportProgress: (fetched, total) =>
    set((state) => ({
      activeImport: state.activeImport ? { ...state.activeImport, fetched, total } : null,
    })),
  completeImport: (playlistId, trackCount) =>
    set((state) => ({
      activeImport: state.activeImport
        ? { ...state.activeImport, playlistId, fetched: trackCount, total: trackCount, complete: true }
        : null,
    })),
  failImport: (error) =>
    set((state) => ({
      activeImport: state.activeImport ? { ...state.activeImport, error, complete: true } : null,
    })),
  clearImport: () => set({ activeImport: null }),
}));
