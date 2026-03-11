use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Json;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use rand::RngExt;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use crate::Config;

struct SetupState {
    pool: SqlitePool,
    tx: Mutex<Option<tokio::sync::oneshot::Sender<Config>>>,
    setup_token: String,
    submitted: AtomicBool,
    is_reconfigure: bool,
    port: u16,
}

#[derive(Deserialize)]
struct SetupForm {
    discord_token: String,
    guild_id: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    jwt_secret: String,
    setup_token: String,
    youtube_api_key: Option<String>,
}

pub async fn run_setup(
    port: u16,
    pool: SqlitePool,
    is_reconfigure: bool,
) -> anyhow::Result<Config> {
    let mut token_bytes = [0u8; 16];
    rand::rng().fill(&mut token_bytes);
    let setup_token = hex::encode(token_bytes);

    let mode = if is_reconfigure {
        "reconfigure"
    } else {
        "setup"
    };
    info!("============================================");
    info!("  SETUP TOKEN: {setup_token}");
    info!("  Mode: {mode}");
    info!("  Open http://127.0.0.1:{port}/setup in your browser");
    info!("============================================");

    let (tx, rx) = tokio::sync::oneshot::channel();

    let state = Arc::new(SetupState {
        pool,
        tx: Mutex::new(Some(tx)),
        setup_token,
        submitted: AtomicBool::new(false),
        is_reconfigure,
        port,
    });

    let web_origin =
        crate::env_var("WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());

    let origins: Vec<HeaderValue> = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        web_origin,
    ]
    .iter()
    .filter_map(|o| o.parse().ok())
    .collect();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            HeaderName::from_static("x-requested-with"),
        ])
        .allow_credentials(true);

    let mut app = axum::Router::new()
        .route("/setup/submit", post(post_setup))
        .route("/setup/status", get(get_status))
        .route("/setup/info", get(get_setup_info))
        .route("/setup/config", get(get_setup_config))
        .route(
            "/api/{*rest}",
            get(api_unavailable)
                .post(api_unavailable)
                .put(api_unavailable)
                .delete(api_unavailable),
        )
        .layer(middleware::from_fn(csrf_check))
        .layer(cors)
        .layer(middleware::map_response(add_security_headers))
        .with_state(state);

    if let Some(dir) = crate::resolve_static_dir() {
        let index_path = format!("{dir}/index.html");
        let serve_dir = ServeDir::new(&dir);
        let index_fallback = ServeFile::new(&index_path);
        app = app.fallback_service(serve_dir.fallback(index_fallback));
        info!("setup: serving SPA from {dir}");
    } else {
        app = app.fallback(|| async { Html(NO_FRONTEND_HTML) });
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                anyhow::anyhow!(
                    "port {port} is already in use — stop the running server first, then retry --setup"
                )
            } else {
                e.into()
            }
        })?;
    let server = axum::serve(listener, app);

    let config = tokio::select! {
        result = server => {
            result?;
            anyhow::bail!("setup server exited unexpectedly");
        }
        config = rx => {
            config?
        }
    };

    info!("setup complete — transitioning to normal mode");
    Ok(config)
}

async fn add_security_headers(response: Response) -> Response {
    let mut response = response;
    let headers = response.headers_mut();
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'",
        ),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn csrf_check(req: Request, next: Next) -> Result<Response, StatusCode> {
    let is_mutating = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::DELETE | Method::PATCH
    );
    if is_mutating {
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

async fn get_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "setup"}))
}

async fn api_unavailable() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({"error": "server is in setup mode"})),
    )
}

async fn get_setup_info(
    State(state): State<Arc<SetupState>>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let default_redirect_uri = if let Ok(origin) = crate::env_var("WEB_ORIGIN") {
        format!("{origin}/auth/callback")
    } else if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
        if host.contains(':') {
            format!("http://{host}/auth/callback")
        } else {
            format!("http://{host}:{}/auth/callback", state.port)
        }
    } else {
        format!("http://localhost:{}/auth/callback", state.port)
    };

    Json(serde_json::json!({
        "default_redirect_uri": default_redirect_uri,
        "is_reconfigure": state.is_reconfigure,
    }))
}

fn mask_secret(value: &str) -> serde_json::Value {
    if value.len() >= 8 {
        serde_json::Value::String(format!("***{}", &value[value.len() - 4..]))
    } else {
        serde_json::Value::String("***".to_string())
    }
}

async fn get_setup_config(
    State(state): State<Arc<SetupState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !state.is_reconfigure {
        return Err(StatusCode::NOT_FOUND);
    }

    let config = azuki_db::config::load_config(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let get = |key: &str| config.get(key).map(|s| s.as_str()).unwrap_or("");

    Ok(Json(serde_json::json!({
        "discord_client_id": get("discord_client_id"),
        "discord_guild_id": get("discord_guild_id"),
        "discord_redirect_uri": get("discord_redirect_uri"),
        "discord_token": mask_secret(get("discord_token")),
        "discord_client_secret": mask_secret(get("discord_client_secret")),
        "jwt_secret": mask_secret(get("jwt_secret")),
        "youtube_api_key": config.get("youtube_api_key").map(|s| mask_secret(s)),
    })))
}

async fn post_setup(
    State(state): State<Arc<SetupState>>,
    Json(form): Json<SetupForm>,
) -> Result<Json<serde_json::Value>, Response> {
    if state.submitted.load(Ordering::SeqCst) {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "setup already submitted"})),
        )
            .into_response());
    }

    if !constant_time_eq(form.setup_token.as_bytes(), state.setup_token.as_bytes()) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "invalid setup token"})),
        )
            .into_response());
    }

    // In reconfigure mode, merge empty fields with existing config values
    let (discord_token, guild_id, client_id, client_secret, redirect_uri, jwt_secret) =
        if state.is_reconfigure {
            let existing = azuki_db::config::load_config(&state.pool)
                .await
                .map_err(|e| {
                    tracing::error!("failed to load existing config: {e}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": "failed to load existing configuration"})),
                    )
                        .into_response()
                })?;

            let merge = |submitted: &str, key: &str| -> String {
                if submitted.is_empty() {
                    existing.get(key).cloned().unwrap_or_default()
                } else {
                    submitted.to_string()
                }
            };

            (
                merge(&form.discord_token, "discord_token"),
                merge(&form.guild_id, "discord_guild_id"),
                merge(&form.client_id, "discord_client_id"),
                merge(&form.client_secret, "discord_client_secret"),
                merge(&form.redirect_uri, "discord_redirect_uri"),
                merge(&form.jwt_secret, "jwt_secret"),
            )
        } else {
            (
                form.discord_token.clone(),
                form.guild_id.clone(),
                form.client_id.clone(),
                form.client_secret.clone(),
                form.redirect_uri.clone(),
                form.jwt_secret.clone(),
            )
        };

    let fields = [
        ("discord_token", &discord_token),
        ("discord_guild_id", &guild_id),
        ("discord_client_id", &client_id),
        ("discord_client_secret", &client_secret),
        ("discord_redirect_uri", &redirect_uri),
        ("jwt_secret", &jwt_secret),
    ];

    for (key, value) in &fields {
        if value.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("{key} is required")})),
            )
                .into_response());
        }
        if value.chars().any(|c| c.is_control() && c != '\n') {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("{key} contains invalid characters")})),
            )
                .into_response());
        }
    }

    if guild_id.parse::<u64>().is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "guild_id must be a numeric Discord server ID"})),
        )
            .into_response());
    }

    let entries: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    azuki_db::config::save_config(&state.pool, &entries)
        .await
        .map_err(|e| {
            tracing::error!("failed to save config: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "failed to save configuration"})),
            )
                .into_response()
        })?;

    // Handle youtube_api_key: empty = keep existing, "CLEAR" = delete, other = save
    match form.youtube_api_key.as_deref() {
        Some("CLEAR") => {
            azuki_db::config::delete_config(&state.pool, "youtube_api_key")
                .await
                .map_err(|e| {
                    tracing::error!("failed to delete youtube api key: {e}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": "failed to save configuration"})),
                    )
                        .into_response()
                })?;
        }
        Some(yt_key) if !yt_key.is_empty() => {
            azuki_db::config::save_config(&state.pool, &[("youtube_api_key", yt_key)])
                .await
                .map_err(|e| {
                    tracing::error!("failed to save youtube api key: {e}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": "failed to save configuration"})),
                    )
                        .into_response()
                })?;
        }
        _ => {} // empty or None — keep existing value
    }

    let config = Config::load(&state.pool).await.map_err(|e| {
        tracing::error!("failed to reload config: {e}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "failed to verify configuration"})),
        )
            .into_response()
    })?;

    state.submitted.store(true, Ordering::SeqCst);

    let mut tx_lock = state.tx.lock().await;
    if let Some(tx) = tx_lock.take() {
        let _ = tx.send(config);
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

const NO_FRONTEND_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azuki — Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.container{max-width:480px;text-align:center}
h1{font-size:1.5rem;color:#fff;margin-bottom:.5rem}
p{color:#888;margin-bottom:1rem;font-size:.9rem;line-height:1.5}
code{background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:.15rem .4rem;font-size:.85rem;color:#ffb7c9}
</style>
</head>
<body>
<div class="container">
<h1>Frontend not built</h1>
<p>Run <code>npm run build</code> in the <code>frontend/</code> directory first, then restart.</p>
</div>
</body>
</html>"#;
