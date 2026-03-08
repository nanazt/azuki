mod setup;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Context;
use dashmap::DashMap;
use rustls::crypto::CryptoProvider;
use secrecy::{ExposeSecret, SecretString};
use serenity::all::GuildId;
use sqlx::SqlitePool;
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::info;

#[allow(dead_code)]
struct Config {
    discord_token: SecretString,
    discord_guild_id: u64,
    discord_client_id: String,
    discord_client_secret: SecretString,
    discord_redirect_uri: String,
    web_port: u16,
    web_origin: String,
    jwt_secret: SecretString,
    media_dir: String,
    data_dir: String,
    max_upload_size_mb: u64,
    max_cache_size_gb: u64,
    static_dir: Option<String>,
    youtube_api_key: Option<SecretString>,
}

impl Config {
    async fn load(pool: &SqlitePool) -> anyhow::Result<Self> {
        let map = azuki_db::config::load_config(pool).await?;
        let get = |key: &str| -> anyhow::Result<String> {
            map.get(key)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing config: {key}"))
        };
        Ok(Self {
            discord_token: SecretString::from(get("discord_token")?),
            discord_guild_id: get("discord_guild_id")?.parse()?,
            discord_client_id: get("discord_client_id")?,
            discord_client_secret: SecretString::from(get("discord_client_secret")?),
            discord_redirect_uri: get("discord_redirect_uri")?,
            jwt_secret: SecretString::from(get("jwt_secret")?),
            web_port: env_var("WEB_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3000),
            web_origin: env_var("WEB_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:5173".to_string()),
            media_dir: env_var("MEDIA_DIR").unwrap_or_else(|_| "media".to_string()),
            data_dir: env_var("DATA_DIR").unwrap_or_else(|_| "data".to_string()),
            max_upload_size_mb: env_var("MAX_UPLOAD_SIZE_MB")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
            max_cache_size_gb: env_var("MAX_CACHE_SIZE_GB")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            static_dir: env_var("STATIC_DIR").ok().or_else(|| {
                let default = "frontend/dist";
                if std::path::Path::new(default).join("index.html").exists() {
                    Some(default.to_string())
                } else {
                    None
                }
            }),
            youtube_api_key: map
                .get("youtube_api_key")
                .map(|s| SecretString::from(s.clone())),
        })
    }
}

fn env_var(key: &str) -> anyhow::Result<String> {
    std::env::var(key).with_context(|| format!("missing env var: {key}"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Install rustls CryptoProvider before any TLS usage (songbird/reqwest)
    CryptoProvider::install_default(rustls::crypto::aws_lc_rs::default_provider())
        .expect("failed to install CryptoProvider");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "azuki=info,azuki_bot=info,azuki_web=info,azuki_media=info,tower_http=info,sqlx=warn".into()
            }),
        )
        .init();

    // Load .env if present (for optional overrides like WEB_PORT, DATABASE_URL)
    let _ = dotenvy::dotenv();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:azuki.db".to_string());
    let pool = azuki_db::create_pool(&database_url).await?;
    azuki_db::run_migrations(&pool).await?;
    info!("database ready");

    if azuki_db::config::is_configured(&pool).await? {
        let config = Config::load(&pool).await?;
        run_normal(config, pool).await
    } else {
        let port = std::env::var("WEB_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000u16);
        info!("no configuration found — starting setup wizard at http://127.0.0.1:{port}");
        let config = setup::run_setup(port, pool.clone()).await?;
        run_normal(config, pool).await
    }
}

async fn run_normal(config: Config, pool: SqlitePool) -> anyhow::Result<()> {
    // Media
    let media_store = Arc::new(azuki_media::MediaStore::new(
        &config.media_dir,
        config.max_cache_size_gb,
    )?);
    let ytdlp = Arc::new(azuki_media::YtDlp::new(&config.media_dir, &config.data_dir));
    let youtube_client = config.youtube_api_key.as_ref().map(|key| {
        Arc::new(azuki_media::YouTubeClient::new(
            key.expose_secret().to_string(),
        ))
    });
    if youtube_client.is_none() {
        tracing::warn!("youtube_api_key not set — search disabled");
    }
    let youtube = Arc::new(std::sync::RwLock::new(youtube_client));

    // Shared channel lists (bot populates, web reads)
    let voice_channels: Arc<std::sync::RwLock<Vec<(u64, String)>>> =
        Arc::new(std::sync::RwLock::new(Vec::new()));
    let text_channels: Arc<std::sync::RwLock<Vec<(u64, String)>>> =
        Arc::new(std::sync::RwLock::new(Vec::new()));

    // Player — restore state from DB
    let restore_entry_to_queue = |e: azuki_db::queries::history::RestoreEntry| {
        let file_path = e.source_type == "youtube" && e.youtube_id.is_some();
        let fp = if file_path {
            let media_dir = &config.media_dir;
            let yt_id = e.youtube_id.as_deref().unwrap();
            let path = format!("{media_dir}/{yt_id}.opus");
            if std::path::Path::new(&path).exists() {
                Some(path)
            } else {
                None
            }
        } else {
            None
        };
        azuki_player::QueueEntry {
            track: azuki_player::TrackInfo {
                id: e.track_id,
                title: e.title,
                artist: e.artist,
                duration_ms: e.duration_ms as u64,
                thumbnail_url: e.thumbnail_url,
                source_url: e.source_url,
                source_type: e.source_type,
                file_path: fp,
                youtube_id: e.youtube_id,
                volume: e.volume as u8,
            },
            added_by: azuki_player::UserInfo {
                id: e.user_id.clone(),
                username: e.username.unwrap_or_else(|| e.user_id.clone()),
                avatar_url: e.avatar_url,
            },
        }
    };

    let initial_history: Vec<azuki_player::QueueEntry> =
        match azuki_db::queries::history::get_history_for_restore(&pool, 50).await {
            Ok(entries) => entries.into_iter().rev().map(restore_entry_to_queue).collect(),
            Err(e) => {
                tracing::error!("failed to restore history: {e}");
                Vec::new()
            }
        };

    let initial_queue: Vec<azuki_player::QueueEntry> =
        match azuki_db::queries::queue::load_queue(&pool).await {
            Ok(entries) => entries.into_iter().map(restore_entry_to_queue).collect(),
            Err(e) => {
                tracing::error!("failed to restore queue: {e}");
                Vec::new()
            }
        };

    let initial_loop_mode = match azuki_db::queries::queue::load_loop_mode(&pool)
        .await
        .unwrap_or_default()
        .as_str()
    {
        "one" => azuki_player::LoopMode::One,
        "all" => azuki_player::LoopMode::All,
        _ => azuki_player::LoopMode::Off,
    };

    let initial_now_playing: Option<azuki_player::QueueEntry> =
        match azuki_db::queries::queue::load_now_playing(&pool).await {
            Ok(entry) => entry.map(&restore_entry_to_queue),
            Err(e) => {
                tracing::error!("failed to restore now_playing: {e}");
                None
            }
        };

    if !initial_queue.is_empty() || initial_now_playing.is_some() {
        info!(
            "restoring {} queue items, loop_mode={:?}, now_playing={}",
            initial_queue.len(),
            initial_loop_mode,
            initial_now_playing
                .as_ref()
                .map_or("none", |e| e.track.title.as_str()),
        );
    }

    let player = azuki_player::PlayerController::with_state(
        initial_queue,
        initial_history,
        initial_loop_mode,
        initial_now_playing,
    );

    let cancel = CancellationToken::new();

    // WebEvent broadcast channel
    let (web_tx, _) = broadcast::channel::<azuki_web::events::WebSeqEvent>(128);
    let active_downloads: Arc<DashMap<String, azuki_web::events::DownloadStatus>> =
        Arc::new(DashMap::new());
    let (download_tx, download_rx) = mpsc::channel::<azuki_web::DownloadRequest>(20);

    // Web state
    let web_state = azuki_web::WebState {
        db: pool.clone(),
        player: player.clone(),
        ytdlp: ytdlp.clone(),
        media_store: media_store.clone(),
        jwt_secret: config.jwt_secret.expose_secret().to_string(),
        discord_client_id: config.discord_client_id.clone(),
        discord_client_secret: config.discord_client_secret.expose_secret().to_string(),
        discord_redirect_uri: config.discord_redirect_uri.clone(),
        allowed_origins: {
            let mut origins = vec![config.web_origin.clone()];
            let self_origin = format!("http://localhost:{}", config.web_port);
            if !origins.contains(&self_origin) {
                origins.push(self_origin);
            }
            origins
        },
        static_dir: config.static_dir.clone(),
        youtube: Arc::clone(&youtube),
        voice_channels: Arc::clone(&voice_channels),
        text_channels: Arc::clone(&text_channels),
        web_tx: web_tx.clone(),
        active_downloads: Arc::clone(&active_downloads),
        download_tx,
    };

    // Http watch channel for embed sending
    let (http_tx, http_rx) = tokio::sync::watch::channel::<Option<Arc<serenity::all::Http>>>(None);

    // Bot state
    let bot_state = Arc::new(azuki_bot::BotState {
        player: player.clone(),
        ytdlp: ytdlp.clone(),
        db: pool.clone(),
        guild_id: GuildId::new(config.discord_guild_id),
        songbird: Mutex::new(None),
        youtube: Arc::clone(&youtube),
        voice_channels: Arc::clone(&voice_channels),
        text_channels: Arc::clone(&text_channels),
        http_tx,
    });

    // Spawn services
    let bot_cancel = cancel.clone();
    let bot_token = config.discord_token.expose_secret().to_string();
    let bot_guild_id = config.discord_guild_id;
    let bot_handle = tokio::spawn(async move {
        if let Err(e) = azuki_bot::start_bot(&bot_token, bot_guild_id, bot_state, bot_cancel).await
        {
            tracing::error!("bot error: {e}");
        }
    });

    let web_cancel = cancel.clone();
    let web_port = config.web_port;
    let web_handle = tokio::spawn(async move {
        if let Err(e) = azuki_web::start_web(web_state, web_port, web_cancel).await {
            tracing::error!("web server error: {e}");
        }
    });

    // yt-dlp install check (runs concurrently with bot/web startup)
    let ytdlp_init = ytdlp.clone();
    tokio::spawn(async move {
        if let Err(e) = ytdlp_init.ensure_installed().await {
            tracing::warn!("yt-dlp auto-install failed: {e}");
        }
    });

    // Cache cleanup task
    let cleanup_store = media_store.clone();
    let cleanup_cancel = cancel.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Err(e) = cleanup_store.cleanup_cache().await {
                        tracing::warn!("cache cleanup error: {e}");
                    }
                }
                _ = cleanup_cancel.cancelled() => break,
            }
        }
    });

    // Bridge task: PlayerEvent -> WebEvent with unified seq counter + Discord embed
    let bridge_web_tx = web_tx.clone();
    let bridge_player = player.clone();
    let bridge_cancel = cancel.clone();
    let bridge_db = pool.clone();
    let bridge_guild_id = serenity::all::GuildId::new(config.discord_guild_id);
    let bridge_http_rx = http_rx;
    let seq_counter = Arc::new(AtomicU64::new(0));
    tokio::spawn({
        let seq = Arc::clone(&seq_counter);
        async move {
            let mut player_rx = bridge_player.subscribe();

            // Current play_history row ID (set on TrackStarted, cleared on TrackEnded)
            let mut current_history_id: Option<i64> = None;

            // Embed state: (channel_id, message_id, history_record_id, track, display_name, volume)
            let mut current_history: Option<(
                serenity::all::ChannelId,
                serenity::all::MessageId,
                i64,
                azuki_player::TrackInfo,
                String,
                u8,
            )> = None;

            // Volume debounce timer (starts far in the future)
            let debounce_delay = tokio::time::sleep(std::time::Duration::from_secs(86400));
            tokio::pin!(debounce_delay);

            loop {
                tokio::select! {
                    result = player_rx.recv() => {
                        match result {
                            Ok(player_seq_event) => {
                                // Record play history, persist now_playing, send embed when a track starts
                                if let azuki_player::PlayerEvent::TrackStarted { ref track, added_by: ref user_info, .. } = player_seq_event.event {
                                    let history_result = azuki_db::queries::history::record_play(
                                        &bridge_db,
                                        &track.id,
                                        &user_info.id,
                                        track.volume as i64,
                                    ).await;
                                    if let Err(e) = azuki_db::queries::queue::save_now_playing(&bridge_db, &track.id, &user_info.id).await {
                                        tracing::warn!("failed to persist now_playing: {e}");
                                    }
                                    let s = seq.fetch_add(1, Ordering::Relaxed) + 1;
                                    let _ = bridge_web_tx.send(azuki_web::events::WebSeqEvent {
                                        seq: s,
                                        event: azuki_web::events::WebEvent::HistoryAdded {
                                            track: track.clone(),
                                            user_id: user_info.id.clone(),
                                        },
                                    });

                                    if let Ok(ref history_record) = history_result {
                                        current_history_id = Some(history_record.id);
                                    }

                                    // Send Discord embed to history channel
                                    if let Ok(ref history_record) = history_result
                                        && let Ok(Some(ch_str)) = azuki_db::config::get_config(&bridge_db, "history_channel_id").await
                                        && let Ok(ch_u64) = ch_str.parse::<u64>()
                                    {
                                                let channel_id = serenity::all::ChannelId::new(ch_u64);
                                                let http = bridge_http_rx.borrow().clone();
                                                if let Some(ref http) = http {
                                                    // Resolve display name: use UserInfo username, fallback to guild member lookup
                                                    let uid: u64 = user_info.id.parse().unwrap_or(0);
                                                    let display_name = if !user_info.username.is_empty() {
                                                        user_info.username.clone()
                                                    } else if uid > 0 {
                                                        match http.get_member(bridge_guild_id, serenity::all::UserId::new(uid)).await {
                                                            Ok(member) => {
                                                                member.nick.as_deref()
                                                                    .or(member.user.global_name.as_deref())
                                                                    .unwrap_or(&member.user.name)
                                                                    .to_string()
                                                            }
                                                            Err(_) => user_info.id.clone(),
                                                        }
                                                    } else {
                                                        user_info.id.clone()
                                                    };

                                                    // Build thumbnail URL
                                                    let web_base_url = azuki_db::config::get_config(&bridge_db, "web_base_url").await.ok().flatten();
                                                    let thumbnail_url = web_base_url.as_ref().map(|base| {
                                                        format!("{base}/media/thumbnails/{}.jpg", track.id)
                                                    });

                                                    let embed = azuki_bot::embed::build_track_embed(
                                                        track, track.volume, &display_name, thumbnail_url.as_deref(),
                                                    );
                                                    let button = azuki_bot::embed::build_play_button(&track.id);
                                                    let msg = serenity::all::CreateMessage::new()
                                                        .embed(embed)
                                                        .components(vec![button]);

                                                    match channel_id.send_message(http.as_ref(), msg).await {
                                                        Ok(sent) => {
                                                            let _ = azuki_db::queries::history::update_message_id(
                                                                &bridge_db, history_record.id, &sent.id.to_string(),
                                                            ).await;
                                                            current_history = Some((
                                                                channel_id, sent.id, history_record.id,
                                                                track.clone(), display_name, track.volume,
                                                            ));
                                                        }
                                                        Err(e) => tracing::warn!("failed to send history embed: {e}"),
                                                    }
                                                } else {
                                                    tracing::warn!("Http not ready, skipping history embed");
                                                }
                                    }
                                }

                                // VolumeChanged: update local volume + debounce
                                if let azuki_player::PlayerEvent::VolumeChanged { volume } = player_seq_event.event
                                    && let Some((_, _, _, _, _, ref mut v)) = current_history
                                {
                                    *v = volume;
                                    debounce_delay.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_secs(2));
                                }

                                // TrackEnded: finish play + flush pending volume update + clear
                                if let azuki_player::PlayerEvent::TrackEnded { listened_ms, completed, .. } = player_seq_event.event {
                                    if let Some(history_id) = current_history_id.take() {
                                        let _ = azuki_db::queries::history::finish_play(
                                            &bridge_db, history_id, listened_ms as i64, completed,
                                        ).await;
                                    }
                                    if let Some((channel_id, message_id, history_id, ref track, ref display_name, volume)) = current_history {
                                        let http = bridge_http_rx.borrow().clone();
                                        if let Some(ref http) = http {
                                            let web_base_url = azuki_db::config::get_config(&bridge_db, "web_base_url").await.ok().flatten();
                                            let thumbnail_url = web_base_url.as_ref().map(|base| {
                                                format!("{base}/media/thumbnails/{}.jpg", track.id)
                                            });
                                            let embed = azuki_bot::embed::build_track_embed(track, volume, display_name, thumbnail_url.as_deref());
                                            let button = azuki_bot::embed::build_play_button(&track.id);
                                            let edit = serenity::all::EditMessage::new()
                                                .embed(embed)
                                                .components(vec![button]);
                                            let _ = channel_id.edit_message(http.as_ref(), message_id, edit).await;
                                        }
                                        let _ = azuki_db::queries::history::update_history_volume(&bridge_db, history_id, volume as i64).await;
                                    }
                                    current_history = None;
                                    debounce_delay.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_secs(86400));

                                    if let Err(e) = azuki_db::queries::queue::clear_now_playing(&bridge_db).await {
                                        tracing::warn!("failed to clear now_playing: {e}");
                                    }
                                }

                                // Persist queue to DB
                                if let azuki_player::PlayerEvent::QueueUpdated { ref queue } = player_seq_event.event {
                                    let items: Vec<(String, String)> = queue
                                        .iter()
                                        .map(|e| (e.track.id.clone(), e.added_by.id.clone()))
                                        .collect();
                                    if let Err(e) = azuki_db::queries::queue::save_queue(&bridge_db, &items).await {
                                        tracing::warn!("failed to persist queue: {e}");
                                    }
                                }

                                // Persist loop mode to DB
                                if let azuki_player::PlayerEvent::LoopModeChanged { mode } = player_seq_event.event {
                                    let mode_str = match mode {
                                        azuki_player::LoopMode::Off => "off",
                                        azuki_player::LoopMode::One => "one",
                                        azuki_player::LoopMode::All => "all",
                                    };
                                    if let Err(e) = azuki_db::queries::queue::save_loop_mode(&bridge_db, mode_str).await {
                                        tracing::warn!("failed to persist loop mode: {e}");
                                    }
                                }

                                let web_event: azuki_web::events::WebEvent = player_seq_event.event.into();
                                let s = seq.fetch_add(1, Ordering::Relaxed) + 1;
                                let _ = bridge_web_tx.send(azuki_web::events::WebSeqEvent {
                                    seq: s,
                                    event: web_event,
                                });
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!("bridge lagged by {n} events");
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }

                    // Debounce timer: edit embed with updated volume
                    _ = &mut debounce_delay, if current_history.is_some() => {
                        if let Some((channel_id, message_id, history_id, ref track, ref display_name, volume)) = current_history {
                            let http = bridge_http_rx.borrow().clone();
                            if let Some(ref http) = http {
                                let web_base_url = azuki_db::config::get_config(&bridge_db, "web_base_url").await.ok().flatten();
                                let thumbnail_url = web_base_url.as_ref().map(|base| {
                                    format!("{base}/media/thumbnails/{}.jpg", track.id)
                                });
                                let embed = azuki_bot::embed::build_track_embed(track, volume, display_name, thumbnail_url.as_deref());
                                let button = azuki_bot::embed::build_play_button(&track.id);
                                let edit = serenity::all::EditMessage::new()
                                    .embed(embed)
                                    .components(vec![button]);
                                let _ = channel_id.edit_message(http.as_ref(), message_id, edit).await;
                            }
                            let _ = azuki_db::queries::history::update_history_volume(&bridge_db, history_id, volume as i64).await;
                        }
                        debounce_delay.as_mut().reset(tokio::time::Instant::now() + std::time::Duration::from_secs(86400));
                    }

                    _ = bridge_cancel.cancelled() => break,
                }
            }
        }
    });

    // Download worker task
    let dl_web_tx = web_tx.clone();
    let dl_seq = Arc::clone(&seq_counter);
    let dl_active = Arc::clone(&active_downloads);
    let dl_ytdlp = ytdlp.clone();
    let dl_youtube = Arc::clone(&youtube);
    let dl_player = player.clone();
    let dl_db = pool.clone();
    tokio::spawn(download_worker(
        download_rx,
        dl_web_tx,
        dl_seq,
        dl_active,
        dl_ytdlp,
        dl_youtube,
        dl_player,
        dl_db,
    ));

    info!("azuki started — web on port {}", config.web_port);

    // Wait for shutdown signal
    tokio::signal::ctrl_c().await?;
    info!("shutting down...");
    cancel.cancel();

    let _ = tokio::join!(bot_handle, web_handle);
    info!("goodbye!");

    Ok(())
}

fn broadcast_web_event(
    tx: &broadcast::Sender<azuki_web::events::WebSeqEvent>,
    seq: &AtomicU64,
    event: azuki_web::events::WebEvent,
) {
    let s = seq.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = tx.send(azuki_web::events::WebSeqEvent { seq: s, event });
}

#[allow(clippy::too_many_arguments)]
async fn download_worker(
    mut rx: mpsc::Receiver<azuki_web::DownloadRequest>,
    web_tx: broadcast::Sender<azuki_web::events::WebSeqEvent>,
    seq: Arc<AtomicU64>,
    active_downloads: Arc<DashMap<String, azuki_web::events::DownloadStatus>>,
    ytdlp: Arc<azuki_media::YtDlp>,
    youtube: Arc<std::sync::RwLock<Option<Arc<azuki_media::YouTubeClient>>>>,
    player: azuki_player::PlayerController,
    db: SqlitePool,
) {
    while let Some(req) = rx.recv().await {
        let web_tx = web_tx.clone();
        let seq = Arc::clone(&seq);
        let active = Arc::clone(&active_downloads);
        let ytdlp = ytdlp.clone();
        let youtube = Arc::clone(&youtube);
        let player = player.clone();
        let db = db.clone();

        tokio::spawn(async move {
            let download_id = req.download_id.clone();

            // Track active download
            active.insert(
                download_id.clone(),
                azuki_web::events::DownloadStatus {
                    download_id: download_id.clone(),
                    query: req.query_or_url.clone(),
                    percent: 0,
                    speed_bps: None,
                    user_info: Some(req.user_info.clone()),
                    title: None,
                    artist: None,
                    thumbnail_url: None,
                    duration_ms: None,
                    source_url: None,
                },
            );

            broadcast_web_event(
                &web_tx,
                &seq,
                azuki_web::events::WebEvent::DownloadStarted {
                    download_id: download_id.clone(),
                    query: req.query_or_url.clone(),
                    user_info: req.user_info.clone(),
                },
            );

            // Resolve URL if it's a search query
            let is_url =
                req.query_or_url.starts_with("http://") || req.query_or_url.starts_with("https://");
            let url = if is_url {
                // For direct URLs, try to resolve metadata via YouTube API (fast)
                let url_meta_pair = azuki_media::extract_video_id(&req.query_or_url)
                    .zip(youtube.read().unwrap().clone());
                if let Some((vid, client)) = url_meta_pair
                    && let Ok(meta) = client.get_video(&vid).await
                {
                    broadcast_web_event(
                        &web_tx,
                        &seq,
                        azuki_web::events::WebEvent::DownloadMetadataResolved {
                            download_id: download_id.clone(),
                            title: meta.title.clone(),
                            artist: meta.artist.clone(),
                            thumbnail_url: meta.thumbnail_url.clone(),
                            duration_ms: meta.duration_ms,
                            source_url: meta.source_url.clone(),
                        },
                    );
                    if let Some(mut entry) = active.get_mut(&download_id) {
                        entry.title = Some(meta.title);
                        entry.artist = meta.artist;
                        entry.thumbnail_url = meta.thumbnail_url;
                        entry.duration_ms = Some(meta.duration_ms);
                        entry.source_url = Some(meta.source_url);
                    }
                }
                req.query_or_url.clone()
            } else {
                let yt = youtube.read().unwrap().clone();
                match yt {
                    Some(client) => match client.search(&req.query_or_url, 1).await {
                        Ok(results) => match results.into_iter().next() {
                            Some(meta) => {
                                // Broadcast resolved metadata from search result
                                broadcast_web_event(
                                    &web_tx,
                                    &seq,
                                    azuki_web::events::WebEvent::DownloadMetadataResolved {
                                        download_id: download_id.clone(),
                                        title: meta.title.clone(),
                                        artist: meta.artist.clone(),
                                        thumbnail_url: meta.thumbnail_url.clone(),
                                        duration_ms: meta.duration_ms,
                                        source_url: meta.source_url.clone(),
                                    },
                                );
                                if let Some(mut entry) = active.get_mut(&download_id) {
                                    entry.title = Some(meta.title.clone());
                                    entry.artist = meta.artist.clone();
                                    entry.thumbnail_url = meta.thumbnail_url.clone();
                                    entry.duration_ms = Some(meta.duration_ms);
                                    entry.source_url = Some(meta.source_url.clone());
                                }
                                meta.source_url
                            }
                            None => {
                                finish_download_failed(
                                    &web_tx,
                                    &seq,
                                    &active,
                                    &download_id,
                                    "no results found",
                                );
                                return;
                            }
                        },
                        Err(e) => {
                            finish_download_failed(
                                &web_tx,
                                &seq,
                                &active,
                                &download_id,
                                &e.to_string(),
                            );
                            return;
                        }
                    },
                    None => {
                        finish_download_failed(
                            &web_tx,
                            &seq,
                            &active,
                            &download_id,
                            "YouTube API key not configured",
                        );
                        return;
                    }
                }
            };

            // Check if track already exists with a cached file
            let track_id = azuki_web::util::sha_id(&url);
            if let Ok(existing) = azuki_db::queries::tracks::get_track(&db, &track_id).await
                && let Some(ref fp) = existing.file_path
                && std::path::Path::new(fp).exists()
            {
                let track_info = azuki_player::TrackInfo {
                    id: existing.id,
                    title: existing.title,
                    artist: existing.artist,
                    duration_ms: existing.duration_ms as u64,
                    thumbnail_url: existing.thumbnail_url,
                    source_url: existing.source_url,
                    source_type: existing.source_type,
                    file_path: existing.file_path,
                    youtube_id: existing.youtube_id,
                    volume: existing.volume as u8,
                };

                if let Err(e) = player
                    .play_or_enqueue(track_info.clone(), req.user_info.clone())
                    .await
                {
                    active.remove(&download_id);
                    broadcast_web_event(
                        &web_tx,
                        &seq,
                        azuki_web::events::WebEvent::DownloadFailed {
                            download_id,
                            error: e.to_string(),
                        },
                    );
                    return;
                }

                active.remove(&download_id);
                broadcast_web_event(
                    &web_tx,
                    &seq,
                    azuki_web::events::WebEvent::DownloadComplete {
                        download_id,
                        track: track_info,
                    },
                );
                return;
            }

            // Download with progress
            let progress_web_tx = web_tx.clone();
            let progress_seq = Arc::clone(&seq);
            let progress_active = Arc::clone(&active);
            let progress_id = download_id.clone();
            let result = ytdlp
                .download_with_progress(&url, |p| {
                    let pct = p.percent.round().clamp(0.0, 100.0) as u8;

                    if let Some(mut entry) = progress_active.get_mut(&progress_id) {
                        entry.percent = pct;
                        entry.speed_bps = p.speed_bps;
                    }

                    broadcast_web_event(
                        &progress_web_tx,
                        &progress_seq,
                        azuki_web::events::WebEvent::DownloadProgress {
                            download_id: progress_id.clone(),
                            stage: match p.stage {
                                azuki_media::ytdlp::DownloadStage::Resolving => "resolving",
                                azuki_media::ytdlp::DownloadStage::Downloading => "downloading",
                                azuki_media::ytdlp::DownloadStage::Converting => "converting",
                            }
                            .to_string(),
                            percent: pct,
                            speed_bps: p.speed_bps,
                        },
                    );
                })
                .await;
            match result {
                Ok((file_path, meta)) => {
                    let track_id = azuki_web::util::sha_id(&meta.source_url);
                    let file_path_str = file_path.to_string_lossy().to_string();

                    // Download thumbnail
                    if let Some(ref thumb_url) = meta.thumbnail_url {
                        let thumb_path = std::path::Path::new("media/thumbnails")
                            .join(format!("{track_id}.jpg"));
                        if let Err(e) =
                            azuki_media::YtDlp::download_thumbnail(thumb_url, &thumb_path).await
                        {
                            tracing::warn!("thumbnail download failed: {e}");
                        }
                    }

                    let _ = azuki_db::queries::tracks::upsert_track(
                        &db,
                        &track_id,
                        &meta.title,
                        meta.artist.as_deref(),
                        meta.duration_ms as i64,
                        meta.thumbnail_url.as_deref(),
                        &meta.source_url,
                        "youtube",
                        Some(&file_path_str),
                        meta.youtube_id.as_deref(),
                        None,
                    )
                    .await;

                    let track_volume = azuki_db::queries::tracks::get_track(&db, &track_id)
                        .await
                        .map(|t| t.volume as u8)
                        .unwrap_or(5);

                    let track_info = azuki_player::TrackInfo {
                        id: track_id,
                        title: meta.title,
                        artist: meta.artist,
                        duration_ms: meta.duration_ms,
                        thumbnail_url: meta.thumbnail_url,
                        source_url: meta.source_url,
                        source_type: "youtube".to_string(),
                        file_path: Some(file_path_str),
                        youtube_id: meta.youtube_id,
                        volume: track_volume,
                    };

                    if let Err(e) = player
                        .play_or_enqueue(track_info.clone(), req.user_info.clone())
                        .await
                    {
                        active.remove(&download_id);
                        broadcast_web_event(
                            &web_tx,
                            &seq,
                            azuki_web::events::WebEvent::DownloadFailed {
                                download_id,
                                error: e.to_string(),
                            },
                        );
                        return;
                    }

                    active.remove(&download_id);
                    broadcast_web_event(
                        &web_tx,
                        &seq,
                        azuki_web::events::WebEvent::DownloadComplete {
                            download_id,
                            track: track_info,
                        },
                    );
                }
                Err(e) => {
                    finish_download_failed(&web_tx, &seq, &active, &download_id, &e.to_string());
                }
            }
        });
    }
}

fn finish_download_failed(
    web_tx: &broadcast::Sender<azuki_web::events::WebSeqEvent>,
    seq: &AtomicU64,
    active: &DashMap<String, azuki_web::events::DownloadStatus>,
    download_id: &str,
    error: &str,
) {
    active.remove(download_id);
    broadcast_web_event(
        web_tx,
        seq,
        azuki_web::events::WebEvent::DownloadFailed {
            download_id: download_id.to_string(),
            error: error.to_string(),
        },
    );
}
