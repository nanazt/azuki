import type {
  Playlist,
  PlaylistTrack,
  QueueEntry,
  ServerStats,
  TrackInfo,
  UserStats,
} from "./types";

const headers = (): HeadersInit => ({
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
});

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { ...headers(), ...init?.headers },
  });
  if (res.status === 401) {
    window.location.href = "/auth/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function get<T>(url: string) {
  return request<T>(url);
}

function post<T>(url: string, body?: unknown) {
  return request<T>(url, {
    method: "POST",
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function put<T>(url: string, body?: unknown) {
  return request<T>(url, {
    method: "PUT",
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function del<T>(url: string) {
  return request<T>(url, { method: "DELETE" });
}

export const api = {
  // Player
  pause: () => post<void>("/api/player/pause"),
  resume: () => post<void>("/api/player/resume"),
  skip: () => post<void>("/api/player/skip"),
  previous: () => post<void>("/api/player/previous"),
  stop: () => post<void>("/api/player/stop"),
  seek: (position_ms: number) => post<void>("/api/player/seek", { position_ms }),
  setVolume: (volume: number) => post<void>("/api/player/volume", { volume }),
  setLoop: (mode: string) => post<void>("/api/player/loop", { mode }),

  // Queue
  getQueue: () => get<{ now_playing: TrackInfo | null; queue: QueueEntry[] }>("/api/queue"),
  addToQueue: (query_or_url: string) =>
    post<{ download_id: string }>("/api/queue/add", { query_or_url }),
  removeFromQueue: (position: number) => del<void>(`/api/queue/${position}`),

  // Search
  search: (q: string, source = "youtube") =>
    get<{ results: TrackInfo[] }>(`/api/search?q=${encodeURIComponent(q)}&source=${source}`),

  // History
  getHistory: (page = 1, per_page = 20) =>
    get<{ items: { track: TrackInfo; played_at: string; user_id: string; play_count: number }[]; total: number }>(
      `/api/history?page=${page}&per_page=${per_page}`,
    ),

  // Playlists
  getPlaylists: () => get<{ playlists: Playlist[] }>("/api/playlists"),
  createPlaylist: (name: string) => post<Playlist>("/api/playlists", { name }),
  renamePlaylist: (id: number, name: string) => put<void>(`/api/playlists/${id}`, { name }),
  deletePlaylist: (id: number) => del<void>(`/api/playlists/${id}`),
  getPlaylistTracks: (id: number) => get<{ tracks: PlaylistTrack[] }>(`/api/playlists/${id}/tracks`),
  addPlaylistTrack: (id: number, track_id: string, position?: number) =>
    post<void>(`/api/playlists/${id}/tracks`, { track_id, position }),
  removePlaylistTrack: (id: number, position: number) =>
    del<void>(`/api/playlists/${id}/tracks/${position}`),

  // Favorites
  getFavorites: () => get<{ tracks: TrackInfo[] }>("/api/favorites"),
  toggleFavorite: (track_id: string) => post<{ favorited: boolean }>(`/api/favorites/${track_id}`),

  // Stats
  getMyStats: () => get<UserStats>("/api/stats/me"),
  getServerStats: () => get<ServerStats>("/api/stats/server"),
  getTrackStats: (id: string) =>
    get<{ play_count: number; last_played: string | null }>(`/api/stats/track/${id}`),

  // Admin
  getYtdlpInfo: () => get<{ current_version: string | null; managed: boolean }>("/api/admin/ytdlp"),
  checkYtdlpUpdate: () => post<{ latest_version: string; update_available: boolean }>("/api/admin/ytdlp/check"),
  updateYtdlp: () => post<{ version: string | null; success: boolean }>("/api/admin/ytdlp/update"),

  // Me
  getMe: () => get<{ id: string; username: string; avatar_url: string | null }>("/api/me"),

  // Preferences
  getPreferences: () => get<{ theme: string }>("/api/preferences"),
  updatePreferences: (prefs: { theme?: string }) =>
    put<{ theme: string }>("/api/preferences", prefs),

  // Bot Settings
  getBotSettings: () => get<{ default_volume: number }>("/api/settings/bot"),
  updateBotSettings: (settings: { default_volume?: number }) =>
    put<{ default_volume: number }>("/api/settings/bot", settings),

  // Auth
  logout: () => post<void>("/auth/logout"),

  // Admin - YouTube
  getYoutubeInfo: () => get<{ has_key: boolean; key_masked: string | null }>("/api/admin/youtube"),
  setYoutubeKey: (api_key: string) => post<{ success: boolean; restart_required: boolean }>("/api/admin/youtube", { api_key }),

  // Admin - Voice Channel
  getVoiceChannel: () => get<{ default_channel_id: string | null; channels: { id: string; name: string }[] }>("/api/admin/voice-channel"),
  setVoiceChannel: (channel_id: string) => put<{ success: boolean }>("/api/admin/voice-channel", { channel_id }),
};
