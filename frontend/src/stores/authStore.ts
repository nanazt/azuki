import { create } from "zustand";
import { api } from "../lib/api";

interface AuthState {
  authenticated: boolean;
  checking: boolean;
  setAuthenticated: (v: boolean) => void;
  setChecking: (v: boolean) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  authenticated: false,
  checking: true,
  setAuthenticated: (v) => set({ authenticated: v, checking: false }),
  setChecking: (v) => set({ checking: v }),
  logout: async () => {
    try {
      await api.logout();
    } catch {
      // Even if the API call fails, redirect to login
    }
    set({ authenticated: false, checking: false });
    window.location.href = "/login";
  },
}));
