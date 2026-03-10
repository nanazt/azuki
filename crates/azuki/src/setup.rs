use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use rand::RngExt;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tracing::info;

use crate::Config;

struct SetupState {
    pool: SqlitePool,
    tx: Mutex<Option<tokio::sync::oneshot::Sender<Config>>>,
    setup_token: String,
    submitted: AtomicBool,
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

pub async fn run_setup(port: u16, pool: SqlitePool) -> anyhow::Result<Config> {
    let mut token_bytes = [0u8; 16];
    rand::rng().fill(&mut token_bytes);
    let setup_token = hex::encode(token_bytes);

    info!("============================================");
    info!("  SETUP TOKEN: {setup_token}");
    info!("  Open http://127.0.0.1:{port} in your browser");
    info!("============================================");

    let (tx, rx) = tokio::sync::oneshot::channel();

    let state = Arc::new(SetupState {
        pool,
        tx: Mutex::new(Some(tx)),
        setup_token,
        submitted: AtomicBool::new(false),
    });

    let app = axum::Router::new()
        .route("/", get(get_setup_page))
        .route("/setup", get(get_status).post(post_setup))
        .route("/setup/status", get(get_status))
        .layer(axum::middleware::map_response(add_security_headers))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
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
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        ),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn get_setup_page() -> Html<&'static str> {
    Html(SETUP_HTML)
}

async fn get_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "setup"}))
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

    let fields = [
        ("discord_token", &form.discord_token),
        ("discord_guild_id", &form.guild_id),
        ("discord_client_id", &form.client_id),
        ("discord_client_secret", &form.client_secret),
        ("discord_redirect_uri", &form.redirect_uri),
        ("jwt_secret", &form.jwt_secret),
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

    if form.guild_id.parse::<u64>().is_err() {
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

    if let Some(ref yt_key) = form.youtube_api_key
        && !yt_key.is_empty()
    {
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

const SETUP_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azuki — Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.container{max-width:520px;width:100%}
h1{font-size:1.5rem;margin-bottom:.25rem;color:#fff}
.subtitle{color:#888;margin-bottom:1.5rem;font-size:.9rem}
.section{margin-bottom:1.5rem}
.section-title{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:#7c5cff;margin-bottom:.75rem;font-weight:600}
label{display:block;margin-bottom:.5rem}
.label-text{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:.8rem;color:#aaa;margin-bottom:.25rem;display:block}
.input-wrap{position:relative;display:flex}
input{width:100%;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:.6rem .75rem;color:#fff;font-size:.9rem;outline:none;transition:border-color .2s}
input:focus{border-color:#7c5cff}
input::placeholder{color:#555}
.toggle-btn{position:absolute;right:.5rem;top:50%;transform:translateY(-50%);background:none;border:none;color:#666;cursor:pointer;font-size:.75rem;padding:.25rem}
.toggle-btn:hover{color:#aaa}
.gen-row{display:flex;gap:.5rem}
.gen-row input{flex:1}
.gen-btn{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:.6rem .75rem;color:#7c5cff;cursor:pointer;font-size:.8rem;white-space:nowrap;transition:border-color .2s}
.gen-btn:hover{border-color:#7c5cff}
.token-section{margin-top:1.5rem;padding-top:1.5rem;border-top:1px solid #222}
.submit-btn{width:100%;background:#7c5cff;color:#fff;border:none;border-radius:6px;padding:.75rem;font-size:1rem;font-weight:600;cursor:pointer;transition:opacity .2s;margin-top:1rem}
.submit-btn:hover{opacity:.9}
.submit-btn:disabled{opacity:.5;cursor:not-allowed}
.status{text-align:center;margin-top:1rem;font-size:.9rem;display:none}
.status.error{color:#ff5c5c;display:block}
.status.success{color:#5cff7c;display:block}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:.5rem}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container">
<h1>Azuki setup</h1>
<p class="subtitle">Configure your Discord music bot</p>
<form id="form">
<div class="section">
<div class="section-title">Discord Credentials</div>
<label>
<span class="label-text">DISCORD_TOKEN</span>
<div class="input-wrap">
<input type="password" name="discord_token" required placeholder="Bot token from Discord Developer Portal" autocomplete="off">
<button type="button" class="toggle-btn" onclick="toggleVis(this)">show</button>
</div>
</label>
<label>
<span class="label-text">DISCORD_GUILD_ID</span>
<input type="text" name="guild_id" required placeholder="Server ID (right-click server → Copy ID)" autocomplete="off">
</label>
<label>
<span class="label-text">DISCORD_CLIENT_ID</span>
<input type="text" name="client_id" required placeholder="Application ID from Discord Developer Portal" autocomplete="off">
</label>
<label>
<span class="label-text">DISCORD_CLIENT_SECRET</span>
<div class="input-wrap">
<input type="password" name="client_secret" required placeholder="OAuth2 client secret" autocomplete="off">
<button type="button" class="toggle-btn" onclick="toggleVis(this)">show</button>
</div>
</label>
<label>
<span class="label-text">DISCORD_REDIRECT_URI</span>
<input type="text" name="redirect_uri" required value="http://localhost:3000/auth/callback" autocomplete="off">
</label>
</div>
<div class="section">
<div class="section-title">Session Security</div>
<label>
<span class="label-text">JWT_SECRET</span>
<div class="gen-row">
<div class="input-wrap" style="flex:1">
<input type="password" name="jwt_secret" required placeholder="Random secret for JWT signing" autocomplete="off">
<button type="button" class="toggle-btn" onclick="toggleVis(this)">show</button>
</div>
<button type="button" class="gen-btn" onclick="generateSecret()">Generate</button>
</div>
</label>
</div>
<div class="section">
<div class="section-title">YouTube API (Optional)</div>
<label>
<span class="label-text">YOUTUBE_API_KEY</span>
<div class="input-wrap">
<input type="password" name="youtube_api_key" placeholder="YouTube Data API v3 key (can set later in Settings)" autocomplete="off">
<button type="button" class="toggle-btn" onclick="toggleVis(this)">show</button>
</div>
</label>
</div>
<div class="token-section">
<label>
<span class="label-text">SETUP TOKEN (from terminal)</span>
<input type="text" name="setup_token" required placeholder="Paste the token shown in your terminal" autocomplete="off">
</label>
</div>
<button type="submit" class="submit-btn" id="submitBtn">Complete Setup</button>
<div id="status" class="status"></div>
</form>
</div>
<script>
function toggleVis(btn){
  const inp=btn.parentElement.querySelector('input');
  if(inp.type==='password'){inp.type='text';btn.textContent='hide'}
  else{inp.type='password';btn.textContent='show'}
}
function generateSecret(){
  const arr=new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex=Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('');
  document.querySelector('input[name="jwt_secret"]').value=hex;
}
document.getElementById('form').addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=document.getElementById('submitBtn');
  const status=document.getElementById('status');
  btn.disabled=true;
  btn.textContent='Saving...';
  status.className='status';status.textContent='';
  const fd=new FormData(e.target);
  const body=Object.fromEntries(fd.entries());
  try{
    const res=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(!res.ok){
      status.className='status error';
      status.textContent=data.error||'Setup failed';
      btn.disabled=false;btn.textContent='Complete Setup';
      return;
    }
    status.className='status success';
    status.textContent='Starting Azuki...';
    setTimeout(()=>{
      const poll=setInterval(async()=>{
        try{
          const r=await fetch('/setup/status');
          if(!r.ok)throw new Error();
        }catch{
          clearInterval(poll);
          window.location.href='/';
        }
      },500);
    },1000);
  }catch(err){
    status.className='status error';
    status.textContent='Connection error — check terminal';
    btn.disabled=false;btn.textContent='Complete Setup';
  }
});
</script>
</body>
</html>"#;
