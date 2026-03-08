export interface TrackInfo {
  id: string;
  title: string;
  artist: string | null;
  duration_ms: number;
  thumbnail_url: string | null;
  source_url: string;
  source_type: string;
  file_path: string | null;
  youtube_id: string | null;
  volume: number;
}

export interface QueueEntry {
  track: TrackInfo;
  added_by: UserInfo;
}

export interface UserInfo {
  id: string;
  username: string;
  avatar_url: string | null;
}

export type LoopMode = "off" | "one" | "all";

export interface DownloadStatus {
  download_id: string;
  query: string;
  percent: number;
  speed_bps: number | null;
  user_info?: UserInfo | null;
  title?: string | null;
  artist?: string | null;
  thumbnail_url?: string | null;
  duration_ms?: number | null;
  source_url?: string | null;
}

export interface PlayerSnapshot {
  state: PlayStateInfo;
  queue: QueueEntry[];
  volume: number;
  loop_mode: LoopMode;
  listeners: UserInfo[];
  current_added_by?: UserInfo | null;
  active_downloads?: DownloadStatus[];
}

export type PlayStateInfo =
  | { status: "idle" }
  | { status: "loading"; track: TrackInfo }
  | { status: "playing"; track: TrackInfo; position_ms: number }
  | { status: "paused"; track: TrackInfo; position_ms: number }
  | { status: "error"; track: TrackInfo; error: string };

export type PlayerEvent =
  | { type: "track_started"; track: TrackInfo; position_ms: number; added_by: UserInfo }
  | { type: "track_ended"; track_id: string }
  | { type: "track_loading"; track: TrackInfo }
  | { type: "track_error"; track_id: string; error: string }
  | { type: "paused"; position_ms: number }
  | { type: "resumed"; position_ms: number }
  | { type: "seeked"; position_ms: number }
  | { type: "volume_changed"; volume: number }
  | { type: "queue_updated"; queue: QueueEntry[] }
  | { type: "loop_mode_changed"; mode: LoopMode }
  | {
      type: "video_sync";
      youtube_id: string;
      position_ms: number;
      is_playing: boolean;
      server_timestamp_ms: number;
    }
  | { type: "listeners_updated"; users: UserInfo[] }
  | { type: "state_snapshot"; state: PlayerSnapshot }
  | { type: "download_started"; download_id: string; query: string; user_info: UserInfo }
  | { type: "download_metadata_resolved"; download_id: string; title: string; artist: string | null; thumbnail_url: string | null; duration_ms: number; source_url: string }
  | { type: "download_progress"; download_id: string; percent: number; speed_bps: number | null }
  | { type: "download_complete"; download_id: string; track: TrackInfo }
  | { type: "download_failed"; download_id: string; error: string }
  | { type: "playlist_updated"; playlist_id: number }
  | { type: "history_added"; track: TrackInfo; user_id: string }
  | { type: "history_updated"; history: QueueEntry[] };

export interface SeqEvent {
  seq: number;
  event: PlayerEvent;
}

export interface Playlist {
  id: number;
  name: string;
  owner_id: string | null;
  is_shared: boolean;
  created_at: string;
  track_count?: number;
}

export interface PlaylistTrack {
  track: TrackInfo;
  position: number;
  added_by: string | null;
  added_at: string;
}

export interface UserStats {
  total_plays: number;
  total_time_ms: number;
  top_tracks: { track: TrackInfo; play_count: number }[];
}

export interface ServerStats {
  total_plays: number;
  total_time_ms: number;
  unique_tracks: number;
  top_tracks: { track: TrackInfo; play_count: number }[];
  hourly_activity: number[];
}

export interface UploadResponse {
  track_id: string;
  filename: string;
  title: string;
  artist: string | null;
  duration_ms: number;
  added_by: string;
  duplicate: boolean;
}

export interface CursorResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export interface UploadsResponse extends CursorResponse<TrackInfo> {
  total: number;
}

export interface OEmbedResponse {
  title?: string;
  thumbnail_url?: string;
  provider_name?: string;
  [key: string]: unknown;
}
