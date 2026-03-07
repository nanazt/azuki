pub mod auth;
pub mod events;
pub mod routes;
pub mod ws;

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use dashmap::DashMap;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::info;

use azuki_media::{MediaStore, YouTubeClient, YtDlp};
use azuki_player::PlayerController;

use crate::events::{DownloadStatus, WebSeqEvent};

/// Request to download and enqueue a track.
#[derive(Debug)]
pub struct DownloadRequest {
    pub query_or_url: String,
    pub user_id: String,
    pub download_id: String,
}

#[derive(Clone)]
pub struct WebState {
    pub db: SqlitePool,
    pub player: PlayerController,
    pub ytdlp: Arc<YtDlp>,
    pub media_store: Arc<MediaStore>,
    pub youtube: Arc<RwLock<Option<Arc<YouTubeClient>>>>,
    pub jwt_secret: String,
    pub discord_client_id: String,
    pub discord_client_secret: String,
    pub discord_redirect_uri: String,
    pub allowed_origins: Vec<String>,
    pub static_dir: Option<String>,
    pub voice_channels: Arc<RwLock<Vec<(u64, String)>>>,
    pub web_tx: broadcast::Sender<WebSeqEvent>,
    pub active_downloads: Arc<DashMap<String, DownloadStatus>>,
    pub download_tx: mpsc::Sender<DownloadRequest>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("internal error: {0}")]
    Internal(String),
    #[error("{0}")]
    Player(#[from] azuki_player::PlayerError),
    #[error("{0}")]
    Media(#[from] azuki_media::MediaError),
    #[error("{0}")]
    Db(#[from] azuki_db::DbError),
}

impl From<StatusCode> for ApiError {
    fn from(status: StatusCode) -> Self {
        match status {
            StatusCode::UNAUTHORIZED => Self::Unauthorized,
            StatusCode::FORBIDDEN => Self::Forbidden,
            _ => Self::Internal(status.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, self.to_string()),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            ApiError::Player(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Media(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
        };

        (status, axum::Json(serde_json::json!({ "error": message }))).into_response()
    }
}

async fn csrf_check(req: Request, next: Next) -> Result<axum::response::Response, StatusCode> {
    let dominated = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::DELETE | Method::PATCH
    );
    if dominated {
        let has_header = req
            .headers()
            .get("x-requested-with")
            .and_then(|v| v.to_str().ok())
            == Some("XMLHttpRequest");
        if !has_header {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(next.run(req).await)
}

pub mod util {
    use sha2::{Digest, Sha256};

    pub fn sha_id(input: &str) -> String {
        let hash = Sha256::digest(input.as_bytes());
        hex::encode(&hash[..8])
    }
}

pub async fn start_web(
    state: WebState,
    port: u16,
    cancel: CancellationToken,
) -> anyhow::Result<()> {
    let origins: Vec<HeaderValue> = state
        .allowed_origins
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            HeaderName::from_static("x-requested-with"),
        ])
        .allow_credentials(true);

    let static_dir = state.static_dir.clone();

    // API routes with CSRF protection
    let api_routes = axum::Router::new()
        .merge(routes::player::player_routes())
        .merge(routes::content::content_routes())
        .merge(routes::playlists::playlist_routes())
        .merge(routes::favorites::favorites_routes())
        .merge(routes::stats::stats_routes())
        .merge(routes::admin::admin_routes())
        .merge(routes::preferences::preferences_routes())
        .layer(middleware::from_fn(csrf_check));

    let mut app = axum::Router::new()
        .merge(auth::auth_routes())
        .merge(api_routes)
        .merge(ws::ws_routes())
        .layer(cors)
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        ))
        .with_state(state);

    // SPA serving: serve static files with fallback to index.html
    if let Some(dir) = static_dir {
        let index_path = format!("{dir}/index.html");
        let serve_dir = ServeDir::new(&dir);
        let index_fallback = ServeFile::new(&index_path);
        // Use nested fallback: try static files first, then serve index.html for SPA routes
        app = app.fallback_service(serve_dir.fallback(index_fallback));
        info!("serving SPA from {dir}");
    } else {
        app = app.fallback(|| async { axum::response::Html(NO_FRONTEND_HTML) });
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("web server listening on {addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            cancel.cancelled().await;
        })
        .await?;

    Ok(())
}

const NO_FRONTEND_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>azuki</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.container{max-width:480px;text-align:center}
h1{font-size:1.5rem;color:#fff;margin-bottom:.5rem}
p{color:#888;margin-bottom:1rem;font-size:.9rem;line-height:1.5}
code{background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:.15rem .4rem;font-size:.85rem;color:#7c5cff}
.steps{text-align:left;margin:1.5rem 0}
.step{margin-bottom:.75rem;padding-left:1.5rem;position:relative}
.step::before{content:attr(data-n);position:absolute;left:0;color:#7c5cff;font-weight:600}
.status{margin-top:1.5rem;padding:1rem;background:#1a1a1a;border:1px solid #333;border-radius:6px}
.ok{color:#5cff7c}.warn{color:#ffb35c}
</style>
</head>
<body>
<div class="container">
<h1>azuki is running</h1>
<p>The backend is ready, but no frontend is configured.</p>
<div class="steps">
<div class="step" data-n="1.">Build the frontend: <code>cd frontend && npm install && npm run build</code></div>
<div class="step" data-n="2.">Set the env var: <code>STATIC_DIR=frontend/dist</code></div>
<div class="step" data-n="3.">Restart azuki</div>
</div>
<div class="steps">
<p style="color:#aaa;font-size:.85rem">Or for development:</p>
<div class="step" data-n="*">Run <code>cd frontend && npm run dev</code> and open <code>http://localhost:5173</code></div>
</div>
<div class="status">
<span class="ok">API</span> ready at <code>/api</code> &middot;
<span class="ok">WebSocket</span> at <code>/ws</code> &middot;
<span class="ok">Auth</span> at <code>/auth</code>
</div>
</div>
</body>
</html>"#;
