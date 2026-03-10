use std::sync::atomic::{AtomicU8, Ordering};

pub struct Messages {
    // play actions
    pub playing_now: &'static str,
    pub enqueued: &'static str,
    pub paused: &'static str,
    pub resumed: &'static str,
    pub skipped_to: &'static str,
    pub skipped_empty: &'static str,
    pub nothing_playing: &'static str,
    // player errors
    pub no_track: &'static str,
    pub invalid_state: &'static str,
    pub invalid_position: &'static str,
    pub queue_full: &'static str,
    pub duplicate: &'static str,
    pub join_voice_first: &'static str,
    pub track_not_found: &'static str,
    pub invalid_track_id: &'static str,
    // download/URL
    pub downloading: &'static str,
    pub re_downloading: &'static str,
    pub download_failed: &'static str,
    pub invalid_url: &'static str,
    pub invalid_url_scheme: &'static str,
    pub loading: &'static str,
    // embed labels
    pub embed_duration: &'static str,
    pub embed_volume: &'static str,
    pub embed_play_button: &'static str,
    // select menu
    pub select_track: &'static str,
    // loop modes
    pub loop_off: &'static str,
    pub loop_one: &'static str,
    pub loop_all: &'static str,
    // error / fallback
    pub error_prefix: &'static str,
    pub unknown: &'static str,
    pub no_results: &'static str,
    pub youtube_key_missing: &'static str,
    // now playing status
    pub paused_at: &'static str,
    pub volume_label: &'static str,
}

pub static KO: Messages = Messages {
    playing_now: "재생 시작했어요",
    enqueued: "대기열에 추가됐어요",
    paused: "⏸️ 일시정지했어요",
    resumed: "▶️ 재생했어요",
    skipped_to: "⏭️ 건너뛰기했어요",
    skipped_empty: "⏭️ 건너뛰기 — 대기열 비어있어요",
    nothing_playing: "재생 중인 곡이 없어요",
    no_track: "재생 중인 곡이 없어요",
    invalid_state: "현재 상태에서 실행할 수 없어요",
    invalid_position: "잘못된 위치이에요",
    queue_full: "대기열이 가득 찼어요",
    duplicate: "이미 대기열에 있는 곡이에요",
    join_voice_first: "음성 채널에 먼저 접속해주세요",
    track_not_found: "트랙을 찾을 수 없어요",
    invalid_track_id: "잘못된 트랙 ID예요",
    downloading: "🔄 다운로드 중이에요",
    re_downloading: "🔄 다시 다운로드 할게요",
    download_failed: "다운로드 실패했어요",
    invalid_url: "잘못된 URL이에요",
    invalid_url_scheme: "잘못된 URL 형식이에요",
    loading: "재생하는 중이에요",
    embed_duration: "⏱️ 재생 시간",
    embed_volume: "🔊 소리 크기",
    embed_play_button: "재생하기",
    select_track: "재생할 트랙을 선택해주세요",
    loop_off: "➡️ 반복 끄기",
    loop_one: "🔂 한 곡 반복",
    loop_all: "🔁 전체 반복",
    error_prefix: "오류",
    unknown: "알 수 없어요",
    no_results: "검색 결과가 없어요",
    youtube_key_missing: "YouTube API 키가 설정되지 않았어요",
    paused_at: "일시정지 중",
    volume_label: "볼륨",
};

pub static EN: Messages = Messages {
    playing_now: "Now playing",
    enqueued: "Added to queue",
    paused: "⏸️ Paused",
    resumed: "▶️ Resumed",
    skipped_to: "⏭️ Skipped →",
    skipped_empty: "⏭️ Skipped — queue empty",
    nothing_playing: "Nothing playing",
    no_track: "Nothing is playing",
    invalid_state: "Cannot perform this action in current state",
    invalid_position: "Invalid position",
    queue_full: "Queue is full",
    duplicate: "Already in queue",
    join_voice_first: "Join a voice channel first",
    track_not_found: "Track not found",
    invalid_track_id: "Invalid track ID",
    downloading: "🔄 Downloading...",
    re_downloading: "🔄 Re-downloading...",
    download_failed: "Download failed",
    invalid_url: "Invalid URL",
    invalid_url_scheme: "Invalid URL scheme",
    loading: "Loading...",
    embed_duration: "⏱️ Duration",
    embed_volume: "🔊 Volume",
    embed_play_button: "Play",
    select_track: "Select a track to play",
    loop_off: "➡️ Loop off",
    loop_one: "🔂 Loop one",
    loop_all: "🔁 Loop all",
    error_prefix: "Error",
    unknown: "Unknown",
    no_results: "No results found",
    youtube_key_missing: "YouTube API key not configured",
    paused_at: "paused at",
    volume_label: "Volume",
};

/// 0 = ko (default), 1 = en
pub fn get(locale: &AtomicU8) -> &'static Messages {
    match locale.load(Ordering::Relaxed) {
        1 => &EN,
        _ => &KO,
    }
}

/// Parse locale string to u8 value
pub fn locale_to_u8(locale: &str) -> u8 {
    match locale {
        "en" => 1,
        _ => 0, // "ko" or default
    }
}

/// Convert u8 locale value to string
pub fn u8_to_locale(val: u8) -> &'static str {
    match val {
        1 => "en",
        _ => "ko",
    }
}
