use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::WebState;
use crate::auth::extract_user_id;
use crate::events::WebEvent;

pub async fn ws_upgrade(
    jar: CookieJar,
    headers: HeaderMap,
    State(state): State<WebState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Validate origin
    let origin = match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(o) => o,
        None => {
            return (axum::http::StatusCode::FORBIDDEN, "missing origin").into_response();
        }
    };
    if !state.allowed_origins.iter().any(|o| o == origin) {
        return (axum::http::StatusCode::FORBIDDEN, "invalid origin").into_response();
    }

    // Auth from cookie
    let user_id = match extract_user_id(&jar, &state).await {
        Ok(id) => id,
        Err(_) => {
            return (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    };

    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle_ws(socket, state, user_id))
        .into_response()
}

async fn handle_ws(socket: WebSocket, state: WebState, user_id: String) {
    let (mut sender, mut receiver) = socket.split();
    let mut event_rx = state.web_tx.subscribe();
    let (response_tx, mut response_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    debug!("WebSocket connected: {user_id}");

    // Send initial state snapshot with active downloads
    let snapshot = state.player.get_state().await;
    let downloads: Vec<_> = state
        .active_downloads
        .iter()
        .map(|entry| entry.value().clone())
        .collect();

    let snapshot_event = WebEvent::StateSnapshot {
        state: snapshot,
        active_downloads: downloads,
    };
    if let Ok(json) = serde_json::to_string(&snapshot_event) {
        let _ = sender.send(Message::Text(json.into())).await;
    }

    // Forward web events and error responses to WebSocket
    let state_clone = state.clone();
    let forward_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                event = event_rx.recv() => {
                    match event {
                        Ok(seq_event) => {
                            if let Ok(json) = serde_json::to_string(&seq_event)
                                && sender.send(Message::Text(json.into())).await.is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("WS client lagged by {n}, sending snapshot");
                            let snapshot = state_clone.player.get_state().await;
                            let downloads: Vec<_> = state_clone
                                .active_downloads
                                .iter()
                                .map(|entry| entry.value().clone())
                                .collect();
                            let event = crate::events::WebSeqEvent {
                                seq: 0,
                                event: WebEvent::StateSnapshot {
                                    state: snapshot,
                                    active_downloads: downloads,
                                },
                            };
                            if let Ok(json) = serde_json::to_string(&event)
                                && sender.send(Message::Text(json.into())).await.is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                response = response_rx.recv() => {
                    match response {
                        Some(msg) => {
                            if sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    // Handle incoming client messages (control commands)
    let mut last_sync = Instant::now() - Duration::from_secs(1);
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Handle sync command separately with rate limiting
                if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text)
                    && cmd.get("action").and_then(|a| a.as_str()) == Some("sync")
                {
                    if last_sync.elapsed() >= Duration::from_millis(500) {
                        last_sync = Instant::now();
                        let snapshot = state.player.get_state().await;
                        let downloads: Vec<_> = state
                            .active_downloads
                            .iter()
                            .map(|e| e.value().clone())
                            .collect();
                        let event = WebEvent::StateSnapshot {
                            state: snapshot,
                            active_downloads: downloads,
                        };
                        if let Ok(json) = serde_json::to_string(&event) {
                            let _ = response_tx.send(json);
                        }
                    }
                    continue;
                }
                if let Some(err_json) = handle_ws_command(&text, &state, &user_id).await {
                    let _ = response_tx.send(err_json);
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    debug!("WebSocket disconnected: {user_id}");
    forward_task.abort();
}

/// Returns `Some(json)` with an error message to send back to the client on failure.
async fn handle_ws_command(text: &str, state: &WebState, _user_id: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct WsCommand {
        action: String,
        #[serde(default)]
        position_ms: Option<u64>,
        #[serde(default)]
        volume: Option<u8>,
        #[serde(default)]
        mode: Option<String>,
    }

    fn err_json(action: &str, msg: &str) -> Option<String> {
        serde_json::to_string(&serde_json::json!({
            "type": "command_error",
            "action": action,
            "message": msg,
        }))
        .ok()
    }

    let cmd: WsCommand = match serde_json::from_str(text) {
        Ok(c) => c,
        Err(_) => return None,
    };

    match cmd.action.as_str() {
        "pause" => {
            if let Err(e) = state.player.pause().await {
                return err_json("pause", &e.to_string());
            }
        }
        "resume" => {
            if let Err(e) = state.player.resume().await {
                return err_json("resume", &e.to_string());
            }
        }
        "skip" => {
            if let Err(e) = state.player.skip().await {
                return err_json("skip", &e.to_string());
            }
        }
        "stop" => {
            if let Err(e) = state.player.stop().await {
                return err_json("stop", &e.to_string());
            }
        }
        "seek" => {
            if let Some(pos) = cmd.position_ms
                && let Err(e) = state.player.seek(pos).await
            {
                return err_json("seek", &e.to_string());
            }
        }
        "volume" => {
            if let Some(vol) = cmd.volume {
                if vol > 100 {
                    return err_json("volume", "volume must be 0-100");
                }
                if let Err(e) = state.player.set_volume(vol).await {
                    return err_json("volume", &e.to_string());
                }
                let snapshot = state.player.get_state().await;
                if let azuki_player::PlayStateInfo::Playing { ref track, .. }
                | azuki_player::PlayStateInfo::Paused { ref track, .. } = snapshot.state
                {
                    azuki_db::queries::tracks::update_track_volume(
                        &state.db, &track.id, vol as i64,
                    )
                    .await
                    .ok();
                }
            }
        }
        "loop" => {
            if let Some(mode) = &cmd.mode {
                let lm = match mode.as_str() {
                    "one" => azuki_player::LoopMode::One,
                    "all" => azuki_player::LoopMode::All,
                    _ => azuki_player::LoopMode::Off,
                };
                if let Err(e) = state.player.set_loop(lm).await {
                    return err_json("loop", &e.to_string());
                }
            }
        }
        _ => {}
    }
    None
}

pub fn ws_routes() -> axum::Router<WebState> {
    axum::Router::new().route("/ws", axum::routing::get(ws_upgrade))
}
