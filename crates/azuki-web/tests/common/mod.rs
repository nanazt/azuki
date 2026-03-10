#![allow(dead_code, unused_imports)]

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use dashmap::DashMap;
use http_body_util::BodyExt;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc};
use tower::ServiceExt;

use azuki_media::{MediaStore, YtDlp};
use azuki_player::PlayerController;
use azuki_web::events::{DownloadStatus, WebSeqEvent};
use azuki_web::guild::GuildMemberCache;
use azuki_web::{DownloadRequest, WebState, build_router};

pub struct TestApp {
    pub router: axum::Router,
    pub db: SqlitePool,
    pub jwt_secret: String,
    pub media_dir_path: PathBuf,
    pub guild_member_cache: Arc<GuildMemberCache>,
    _media_dir: tempfile::TempDir,
    _download_rx: mpsc::Receiver<DownloadRequest>,
}

struct BuildParts {
    state: WebState,
    db: SqlitePool,
    jwt_secret: String,
    media_dir_path: PathBuf,
    media_dir: tempfile::TempDir,
    download_rx: mpsc::Receiver<DownloadRequest>,
    guild_member_cache: Arc<GuildMemberCache>,
}

async fn build_state(guild_id: u64, discord_api_base: &str) -> BuildParts {
    let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
    azuki_db::run_migrations(&db).await.unwrap();

    let media_dir = tempfile::tempdir().unwrap();
    let media_dir_path = media_dir.path().to_path_buf();

    let player = PlayerController::new();
    let ytdlp = Arc::new(YtDlp::new(&media_dir_path, &media_dir_path));
    let media_store = Arc::new(MediaStore::new(&media_dir_path, 1).unwrap());
    let youtube: Arc<RwLock<Option<Arc<azuki_media::YouTubeClient>>>> = Arc::new(RwLock::new(None));

    let (web_tx, _) = broadcast::channel::<WebSeqEvent>(64);
    let (download_tx, download_rx) = mpsc::channel::<DownloadRequest>(8);

    let jwt_secret = "test-secret".to_string();
    let guild_member_cache = Arc::new(GuildMemberCache::new());

    let state = WebState {
        db: db.clone(),
        player,
        ytdlp,
        media_store,
        youtube,
        jwt_secret: jwt_secret.clone(),
        discord_client_id: "dummy-client-id".to_string(),
        discord_client_secret: "dummy-client-secret".to_string(),
        discord_redirect_uri: "http://localhost/auth/callback".to_string(),
        allowed_origins: vec!["http://localhost".to_string()],
        static_dir: None,
        voice_channels: Arc::new(RwLock::new(Vec::new())),
        text_channels: Arc::new(RwLock::new(Vec::new())),
        web_tx,
        active_downloads: Arc::new(DashMap::new()),
        download_tx,
        history_channel_id: Arc::new(AtomicU64::new(0)),
        bot_locale: Arc::new(std::sync::atomic::AtomicU8::new(0)),
        max_upload_size_mb: 100,
        http_client: reqwest::Client::new(),
        guild_id,
        bot_token: String::new(),
        discord_api_base: discord_api_base.to_string(),
        guild_member_cache: guild_member_cache.clone(),
    };

    BuildParts {
        state,
        db,
        jwt_secret,
        media_dir_path,
        media_dir,
        download_rx,
        guild_member_cache,
    }
}

impl TestApp {
    pub async fn new() -> Self {
        let parts = build_state(0, "").await;
        let router = build_router(parts.state);
        Self {
            router,
            db: parts.db,
            jwt_secret: parts.jwt_secret,
            media_dir_path: parts.media_dir_path,
            guild_member_cache: parts.guild_member_cache,
            _media_dir: parts.media_dir,
            _download_rx: parts.download_rx,
        }
    }

    pub async fn with_guild(guild_id: u64, discord_api_base: &str) -> Self {
        let parts = build_state(guild_id, discord_api_base).await;
        let router = build_router(parts.state);
        Self {
            router,
            db: parts.db,
            jwt_secret: parts.jwt_secret,
            media_dir_path: parts.media_dir_path,
            guild_member_cache: parts.guild_member_cache,
            _media_dir: parts.media_dir,
            _download_rx: parts.download_rx,
        }
    }
}

// --- Auth helpers ---

pub async fn create_test_user(app: &TestApp, id: &str, username: &str, is_admin: bool) -> String {
    azuki_db::queries::users::upsert_user(&app.db, id, username, None)
        .await
        .unwrap();

    if is_admin {
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?1")
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
    } else {
        sqlx::query("UPDATE users SET is_admin = 0 WHERE id = ?1")
            .bind(id)
            .execute(&app.db)
            .await
            .unwrap();
    }

    let user = azuki_db::queries::users::get_user(&app.db, id)
        .await
        .unwrap();
    let jwt = azuki_web::auth::create_jwt(id, &app.jwt_secret, user.token_version).unwrap();
    format!("azuki_token={jwt}")
}

// --- Request builders ---

pub fn get(path: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(path)
        .header("cookie", cookie)
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::empty())
        .unwrap()
}

pub fn post_json(path: &str, cookie: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

pub fn put_json(path: &str, cookie: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(Method::PUT)
        .uri(path)
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

pub fn delete(path: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .method(Method::DELETE)
        .uri(path)
        .header("cookie", cookie)
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::empty())
        .unwrap()
}

pub fn unauthed_get(path: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(path)
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::empty())
        .unwrap()
}

pub fn unauthed_post(path: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("x-requested-with", "XMLHttpRequest")
        .body(Body::empty())
        .unwrap()
}

pub fn post_no_csrf(path: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap()
}

pub fn put_no_csrf(path: &str, cookie: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method(Method::PUT)
        .uri(path)
        .header("cookie", cookie)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

pub fn delete_no_csrf(path: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .method(Method::DELETE)
        .uri(path)
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap()
}

pub fn options_with_origin(path: &str, origin: &str) -> Request<Body> {
    Request::builder()
        .method(Method::OPTIONS)
        .uri(path)
        .header("origin", origin)
        .header("access-control-request-method", "GET")
        .body(Body::empty())
        .unwrap()
}

// --- Response helpers ---

pub async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

pub async fn send(router: &axum::Router, req: Request<Body>) -> axum::response::Response {
    router.clone().oneshot(req).await.unwrap()
}

// --- Data fixtures ---

pub async fn seed_track(
    app: &TestApp,
    id: &str,
    title: &str,
    source_type: &str,
    uploaded_by: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO tracks (id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, uploaded_by, created_at)
         VALUES (?1, ?2, NULL, 180000, NULL, 'https://example.com', ?3, NULL, NULL, 50, ?4, datetime('now'))"
    )
    .bind(id)
    .bind(title)
    .bind(source_type)
    .bind(uploaded_by)
    .execute(&app.db)
    .await
    .unwrap();
}

pub async fn seed_track_with_file(app: &TestApp, id: &str, title: &str) {
    let file_path = app.media_dir_path.join(format!("{id}.opus"));
    std::fs::write(&file_path, b"dummy audio data").unwrap();
    let file_path_str = file_path.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO tracks (id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, uploaded_by, created_at)
         VALUES (?1, ?2, 'Test Artist', 180000, NULL, 'https://example.com', 'youtube', ?3, NULL, 50, NULL, datetime('now'))"
    )
    .bind(id)
    .bind(title)
    .bind(&file_path_str)
    .execute(&app.db)
    .await
    .unwrap();
}

pub async fn seed_upload_track(app: &TestApp, id: &str, title: &str, uploaded_by: &str) {
    let file_path = app.media_dir_path.join(format!("{id}.opus"));
    std::fs::write(&file_path, b"dummy audio data").unwrap();
    let file_path_str = file_path.to_string_lossy().to_string();

    sqlx::query(
        "INSERT INTO tracks (id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, uploaded_by, created_at)
         VALUES (?1, ?2, 'Test Artist', 180000, NULL, 'upload://test.mp3', 'upload', ?3, NULL, 50, ?4, datetime('now'))"
    )
    .bind(id)
    .bind(title)
    .bind(&file_path_str)
    .bind(uploaded_by)
    .execute(&app.db)
    .await
    .unwrap();
}

pub async fn seed_history(app: &TestApp, track_id: &str, user_id: &str) {
    sqlx::query(
        "INSERT INTO play_history (track_id, user_id, played_at, completed, volume, listened_ms)
         VALUES (?1, ?2, datetime('now'), 1, 50, 180000)",
    )
    .bind(track_id)
    .bind(user_id)
    .execute(&app.db)
    .await
    .unwrap();
}

#[allow(dead_code)]
pub async fn seed_config(app: &TestApp, key: &str, value: &str) {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
    )
    .bind(key)
    .bind(value)
    .execute(&app.db)
    .await
    .unwrap();
}
