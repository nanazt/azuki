import type {
  CursorResponse,
  OEmbedResponse,
  Playlist,
  PlaylistTrack,
  QueueEntry,
  ServerStats,
  TrackInfo,
  UploadResponse,
  UploadsResponse,
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
  playAt: (position: number) => post<void>(`/api/queue/${position}/play`),
  moveInQueue: (from: number, to: number) => put<void>("/api/queue/move", { from, to }),

  // Search
  search: (q: string, source = "youtube") =>
    get<{ results: TrackInfo[] }>(`/api/search?q=${encodeURIComponent(q)}&source=${source}`),

  // History
  getHistory: (cursor?: string, limit = 20) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return get<CursorResponse<{ track: TrackInfo; played_at: string; user_id: string; play_count: number }>>(
      `/api/history?${params}`,
    );
  },

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
  getMe: () => get<{ id: string; username: string; avatar_url: string | null; is_admin: boolean }>("/api/me"),
  deleteTrack: (trackId: string) => del<void>(`/api/tracks/${trackId}`),

  // Preferences
  getPreferences: () => get<{ theme: string }>("/api/preferences"),
  updatePreferences: (prefs: { theme?: string }) =>
    put<{ theme: string }>("/api/preferences", prefs),

  // Bot Settings
  getBotSettings: () => get<{ default_volume: number }>("/api/settings/bot"),
  updateBotSettings: (settings: { default_volume?: number }) =>
    put<{ default_volume: number }>("/api/settings/bot", settings),

  // Uploads
  uploadFile: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (res.status === 401) {
      window.location.href = "/auth/login";
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json() as Promise<UploadResponse>;
  },
  addTrackToQueue: (trackId: string) =>
    post<void>("/api/queue/add-track", { track_id: trackId }),
  getUploads: (cursor?: string, limit = 20) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return get<UploadsResponse>(`/api/uploads?${params}`);
  },
  updateTrack: (trackId: string, data: { title?: string; artist?: string }) =>
    put<TrackInfo>(`/api/tracks/${trackId}`, data),
  fetchOEmbed: (url: string) =>
    get<OEmbedResponse>(`/api/oembed?url=${encodeURIComponent(url)}`),

  // Auth
  logout: () => post<void>("/auth/logout"),

  // Admin - YouTube
  getYoutubeInfo: () => get<{ has_key: boolean; key_masked: string | null }>("/api/admin/youtube"),
  setYoutubeKey: (api_key: string) => post<{ success: boolean; restart_required: boolean }>("/api/admin/youtube", { api_key }),

  // Admin - Voice Channel
  getVoiceChannel: () => get<{ default_channel_id: string | null; channels: { id: string; name: string }[] }>("/api/admin/voice-channel"),
  setVoiceChannel: (channel_id: string) => put<{ success: boolean }>("/api/admin/voice-channel", { channel_id }),
};
