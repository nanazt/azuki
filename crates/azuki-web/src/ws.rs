use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::auth::extract_user_id;
use crate::events::WebEvent;
use crate::WebState;

pub async fn ws_upgrade(
    jar: CookieJar,
    headers: HeaderMap,
    State(state): State<WebState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Validate origin
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok())
        && !state.allowed_origins.iter().any(|o| o == origin) {
            return (axum::http::StatusCode::FORBIDDEN, "invalid origin").into_response();
        }

    // Auth from cookie
    let user_id = match extract_user_id(&jar, &state).await {
        Ok(id) => id,
        Err(_) => {
            return (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    };

    ws.on_upgrade(move |socket| handle_ws(socket, state, user_id))
        .into_response()
}

async fn handle_ws(socket: WebSocket, state: WebState, user_id: String) {
    let (mut sender, mut receiver) = socket.split();
    let mut event_rx = state.web_tx.subscribe();

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

    // Forward web events to WebSocket
    let state_clone = state.clone();
    let forward_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
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
    });

    // Handle incoming client messages (control commands)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                handle_ws_command(&text, &state, &user_id).await;
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    debug!("WebSocket disconnected: {user_id}");
    forward_task.abort();
}

async fn handle_ws_command(text: &str, state: &WebState, _user_id: &str) {
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

    let cmd: WsCommand = match serde_json::from_str(text) {
        Ok(c) => c,
        Err(_) => return,
    };

    match cmd.action.as_str() {
        "pause" => { state.player.pause().await.ok(); }
        "resume" => { state.player.resume().await.ok(); }
        "skip" => { state.player.skip().await.ok(); }
        "stop" => { state.player.stop().await.ok(); }
        "seek" => {
            if let Some(pos) = cmd.position_ms {
                state.player.seek(pos).await.ok();
            }
        }
        "volume" => {
            if let Some(vol) = cmd.volume {
                if vol > 100 { return; }
                state.player.set_volume(vol).await.ok();
                let snapshot = state.player.get_state().await;
                if let azuki_player::PlayStateInfo::Playing { ref track, .. }
                    | azuki_player::PlayStateInfo::Paused { ref track, .. } = snapshot.state
                {
                    azuki_db::queries::tracks::update_track_volume(&state.db, &track.id, vol as i64).await.ok();
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
                state.player.set_loop(lm).await.ok();
            }
        }
        _ => {}
    }
}

pub fn ws_routes() -> axum::Router<WebState> {
    axum::Router::new().route("/ws", axum::routing::get(ws_upgrade))
}
