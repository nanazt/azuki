pub mod commands;
pub mod embed;
pub mod handler;
pub mod voice;

use std::sync::{Arc, RwLock};

use serenity::all::GuildId;
use songbird::Songbird;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use azuki_media::{YtDlp, YouTubeClient};
use azuki_player::PlayerController;

pub struct BotState {
    pub player: PlayerController,
    pub ytdlp: Arc<YtDlp>,
    pub youtube: Arc<RwLock<Option<Arc<YouTubeClient>>>>,
    pub db: SqlitePool,
    pub guild_id: GuildId,
    pub songbird: Mutex<Option<Arc<Songbird>>>,
    pub voice_channels: Arc<RwLock<Vec<(u64, String)>>>,
    pub text_channels: Arc<RwLock<Vec<(u64, String)>>>,
    pub http_tx: tokio::sync::watch::Sender<Option<Arc<serenity::http::Http>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum BotError {
    #[error("serenity error: {0}")]
    Serenity(String),
    #[error("player error: {0}")]
    Player(#[from] azuki_player::PlayerError),
    #[error("media error: {0}")]
    Media(#[from] azuki_media::MediaError),
    #[error("database error: {0}")]
    Db(#[from] azuki_db::DbError),
    #[error("not in a voice channel")]
    NotInVoice,
    #[error("voice error: {0}")]
    Voice(String),
    #[error("no results found")]
    NoResults,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("YouTube API key not configured")]
    NoYouTubeKey,
}

pub use handler::start_bot;
