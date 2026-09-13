use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::CookieJar;
use futures_util::StreamExt;
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use tracing::{debug, warn};

use crate::auth::{Claims, extract_verified_auth, revalidate_claims};
use crate::events::{WebEvent, WebSeqEvent};
use crate::{ApiError, WebState};

const AUTH_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_CLOSE_CODE: u16 = 4001;
const TRANSIENT_CLOSE_CODE: u16 = 1011;
const SHUTDOWN_CLOSE_CODE: u16 = 1001;

pub async fn ws_upgrade(
    jar: CookieJar,
    headers: HeaderMap,
    State(state): State<WebState>,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = match headers.get("origin").and_then(|value| value.to_str().ok()) {
        Some(origin) => origin,
        None => {
            return (axum::http::StatusCode::FORBIDDEN, "missing origin").into_response();
        }
    };
    if !state
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        return (axum::http::StatusCode::FORBIDDEN, "invalid origin").into_response();
    }

    // Subscribe first so a logout racing authentication cannot fall between the database check and this connection's private revocation listener.
    let revocations = state.auth_revocations.subscribe();
    let authenticated = match extract_verified_auth(&jar, &state).await {
        Ok(authenticated) => authenticated,
        Err(error) => return error.into_response(),
    };

    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| handle_ws(socket, state, authenticated.claims, revocations))
        .into_response()
}

async fn handle_ws(
    mut socket: WebSocket,
    state: WebState,
    claims: Claims,
    mut revocations: broadcast::Receiver<crate::auth::AuthRevocation>,
) {
    debug!("WebSocket connected");
    let mut events = state.web_tx.subscribe();

    let expiry_millis = claims
        .exp
        .saturating_mul(1_000)
        .saturating_sub(chrono::Utc::now().timestamp_millis());
    let expiry_delay = Duration::from_millis(u64::try_from(expiry_millis).unwrap_or(0));
    let expiry = tokio::time::sleep(expiry_delay);
    tokio::pin!(expiry);

    // Revalidate after the HTTP upgrade has taken ownership of the socket.
    // This closes the authentication/logout race before protected state is sent.
    let validation = tokio::select! {
        biased;
        () = state.web_shutdown.cancelled() => {
            close_socket(&mut socket, SHUTDOWN_CLOSE_CODE, "server shutting down").await;
            return;
        }
        () = &mut expiry => {
            close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication expired").await;
            return;
        }
        result = revalidate_claims(&claims, &state) => result,
    };
    if let Err(error) = validation {
        close_for_auth_error(&mut socket, &error).await;
        return;
    }

    let initial = tokio::select! {
        biased;
        () = state.web_shutdown.cancelled() => {
            close_socket(&mut socket, SHUTDOWN_CLOSE_CODE, "server shutting down").await;
            return;
        }
        () = &mut expiry => {
            close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication expired").await;
            return;
        }
        result = snapshot_message(&state, None) => {
            match result {
                Ok(message) => message,
                Err(error) => {
                    warn!(%error, "failed to serialize WebSocket state snapshot");
                    close_socket(
                        &mut socket,
                        TRANSIENT_CLOSE_CODE,
                        "state serialization failed",
                    )
                    .await;
                    return;
                }
            }
        }
    };

    loop {
        let validation = tokio::select! {
            biased;
            () = state.web_shutdown.cancelled() => {
                close_socket(&mut socket, SHUTDOWN_CLOSE_CODE, "server shutting down").await;
                return;
            }
            () = &mut expiry => {
                close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication expired").await;
                return;
            }
            result = revalidate_claims(&claims, &state) => result,
        };
        if let Err(error) = validation {
            close_for_auth_error(&mut socket, &error).await;
            return;
        }

        match drain_pending_revocations(&claims, &mut revocations) {
            PendingRevocations::Current => break,
            PendingRevocations::Lagged => continue,
            PendingRevocations::Revoked => {
                close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication revoked").await;
                return;
            }
            PendingRevocations::Closed => {
                close_socket(
                    &mut socket,
                    TRANSIENT_CLOSE_CODE,
                    "authentication service unavailable",
                )
                .await;
                return;
            }
        }
    }

    let initial_bot_status = match bot_status_message(&state) {
        Ok(message) => message,
        Err(error) => {
            warn!(%error, "failed to serialize initial bot status");
            close_socket(
                &mut socket,
                TRANSIENT_CLOSE_CODE,
                "state serialization failed",
            )
            .await;
            return;
        }
    };

    enum InitialSendOutcome {
        Sent,
        Failed,
        Expired,
        Shutdown,
    }
    let send_outcome = {
        let send = async {
            send_message(&mut socket, initial).await
                && send_message(&mut socket, initial_bot_status).await
        };
        tokio::pin!(send);
        tokio::select! {
            biased;
            () = state.web_shutdown.cancelled() => InitialSendOutcome::Shutdown,
            () = &mut expiry => InitialSendOutcome::Expired,
            sent = &mut send => {
                if sent {
                    InitialSendOutcome::Sent
                } else {
                    InitialSendOutcome::Failed
                }
            }
        }
    };
    match send_outcome {
        InitialSendOutcome::Sent => {}
        InitialSendOutcome::Failed => return,
        InitialSendOutcome::Expired => {
            close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication expired").await;
            return;
        }
        InitialSendOutcome::Shutdown => {
            close_socket(&mut socket, SHUTDOWN_CLOSE_CODE, "server shutting down").await;
            return;
        }
    }

    let mut recheck = tokio::time::interval_at(
        tokio::time::Instant::now() + AUTH_RECHECK_INTERVAL,
        AUTH_RECHECK_INTERVAL,
    );
    recheck.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut last_sync = Instant::now() - Duration::from_secs(1);
    loop {
        tokio::select! {
            biased;

            () = state.web_shutdown.cancelled() => {
                close_socket(&mut socket, SHUTDOWN_CLOSE_CODE, "server shutting down").await;
                break;
            }
            () = &mut expiry => {
                close_socket(&mut socket, AUTH_CLOSE_CODE, "authentication expired").await;
                break;
            }
            revocation = revocations.recv() => {
                match revocation {
                    Ok(revocation)
                        if revocation.user_id == claims.sub
                            && revocation.token_version > claims.tv =>
                    {
                        close_socket(
                            &mut socket,
                            AUTH_CLOSE_CODE,
                            "authentication revoked",
                        )
                        .await;
                        break;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "WebSocket revocation receiver lagged");
                        if !revalidate_or_close(&mut socket, &claims, &state).await {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        close_socket(
                            &mut socket,
                            TRANSIENT_CLOSE_CODE,
                            "authentication service unavailable",
                        )
                        .await;
                        break;
                    }
                }
            }
            _ = recheck.tick() => {
                if !revalidate_or_close(&mut socket, &claims, &state).await {
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    break;
                };
                match incoming {
                    Ok(Message::Text(text)) => {
                        let Some(command) = parse_command(&text) else {
                            continue;
                        };

                        // Every recognized command, including rate-limited sync, is approved against current database and membership state.
                        if !revalidate_or_close(&mut socket, &claims, &state).await {
                            break;
                        }

                        if command.action == "sync" {
                            if last_sync.elapsed() >= Duration::from_millis(500) {
                                last_sync = Instant::now();
                                let baseline = *state
                                    .web_seq
                                    .lock()
                                    .expect("web event sequence mutex should not be poisoned");
                                let message =
                                    match snapshot_message(&state, Some(baseline)).await {
                                    Ok(message) => message,
                                    Err(error) => {
                                        warn!(%error, "failed to serialize WebSocket sync snapshot");
                                        close_socket(
                                            &mut socket,
                                            TRANSIENT_CLOSE_CODE,
                                            "state serialization failed",
                                        )
                                        .await;
                                        break;
                                    }
                                };
                                if !send_message(&mut socket, message).await {
                                    break;
                                }
                                if !send_current_bot_status(&mut socket, &state, "sync").await {
                                    break;
                                }
                            }
                            continue;
                        }

                        if let Some(error_json) = handle_ws_command(command, &state).await
                            && !send_message(&mut socket, Message::Text(error_json.into())).await
                        {
                            break;
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        if !send_message(&mut socket, Message::Pong(payload)).await {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(Message::Binary(_) | Message::Pong(_)) => {}
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        let message = match serde_json::to_string(&event) {
                            Ok(json) => Message::Text(json.into()),
                            Err(error) => {
                                warn!(%error, "failed to serialize WebSocket event");
                                close_socket(
                                    &mut socket,
                                    TRANSIENT_CLOSE_CODE,
                                    "event serialization failed",
                                )
                                .await;
                                break;
                            }
                        };
                        if !send_message(&mut socket, message).await {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "WebSocket event receiver lagged; sending snapshot");
                        if !revalidate_or_close(&mut socket, &claims, &state).await {
                            break;
                        }
                        let baseline = *state
                            .web_seq
                            .lock()
                            .expect("web event sequence mutex should not be poisoned");
                        let message = match snapshot_message(&state, Some(baseline)).await {
                            Ok(message) => message,
                            Err(error) => {
                                warn!(%error, "failed to serialize WebSocket recovery snapshot");
                                close_socket(
                                    &mut socket,
                                    TRANSIENT_CLOSE_CODE,
                                    "state serialization failed",
                                )
                                .await;
                                break;
                            }
                        };
                        if !send_message(&mut socket, message).await {
                            break;
                        }
                        if !send_current_bot_status(&mut socket, &state, "recovery").await {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        close_socket(
                            &mut socket,
                            TRANSIENT_CLOSE_CODE,
                            "event service unavailable",
                        )
                        .await;
                        break;
                    }
                }
            }
        }
    }

    debug!("WebSocket disconnected");
}

enum PendingRevocations {
    Current,
    Lagged,
    Revoked,
    Closed,
}

fn drain_pending_revocations(
    claims: &Claims,
    revocations: &mut broadcast::Receiver<crate::auth::AuthRevocation>,
) -> PendingRevocations {
    let mut lagged = false;
    loop {
        match revocations.try_recv() {
            Ok(revocation)
                if revocation.user_id == claims.sub && revocation.token_version > claims.tv =>
            {
                return PendingRevocations::Revoked;
            }
            Ok(_) => {}
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                warn!(
                    skipped,
                    "WebSocket revocation receiver lagged during upgrade"
                );
                lagged = true;
            }
            Err(broadcast::error::TryRecvError::Empty) => {
                return if lagged {
                    PendingRevocations::Lagged
                } else {
                    PendingRevocations::Current
                };
            }
            Err(broadcast::error::TryRecvError::Closed) => {
                return PendingRevocations::Closed;
            }
        }
    }
}

async fn revalidate_or_close(socket: &mut WebSocket, claims: &Claims, state: &WebState) -> bool {
    match revalidate_claims(claims, state).await {
        Ok(_) => true,
        Err(error) => {
            close_for_auth_error(socket, &error).await;
            false
        }
    }
}

async fn close_for_auth_error(socket: &mut WebSocket, error: &ApiError) {
    let (code, reason) = match error {
        ApiError::Unauthorized | ApiError::Forbidden => {
            (AUTH_CLOSE_CODE, "authentication no longer valid")
        }
        _ => (TRANSIENT_CLOSE_CODE, "authentication check failed"),
    };
    close_socket(socket, code, reason).await;
}

async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let close = Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }));
    let _ = tokio::time::timeout(SEND_TIMEOUT, socket.send(close)).await;
}

async fn send_message(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}
async fn send_current_bot_status(
    socket: &mut WebSocket,
    state: &WebState,
    context: &'static str,
) -> bool {
    let message = match bot_status_message(state) {
        Ok(message) => message,
        Err(error) => {
            warn!(%error, context, "failed to serialize WebSocket bot status");
            close_socket(socket, TRANSIENT_CLOSE_CODE, "state serialization failed").await;
            return false;
        }
    };
    send_message(socket, message).await
}

async fn snapshot_message(state: &WebState, sequence: Option<u64>) -> serde_json::Result<Message> {
    let snapshot = state.player.get_state().await;
    let active_downloads = state
        .active_downloads
        .iter()
        .map(|entry| entry.value().clone())
        .collect();
    let event = WebEvent::StateSnapshot {
        state: snapshot,
        active_downloads,
    };
    let json = match sequence {
        Some(seq) => serde_json::to_string(&WebSeqEvent { seq, event })?,
        None => serde_json::to_string(&event)?,
    };
    Ok(Message::Text(json.into()))
}

fn bot_status_message(state: &WebState) -> serde_json::Result<Message> {
    let event = WebEvent::BotStatus {
        status: state.bot_control.status(),
    };
    Ok(Message::Text(serde_json::to_string(&event)?.into()))
}

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

fn parse_command(text: &str) -> Option<WsCommand> {
    serde_json::from_str(text).ok()
}

/// Returns `Some(json)` with an error message to send back to the client on failure.
async fn handle_ws_command(command: WsCommand, state: &WebState) -> Option<String> {
    fn err_json(action: &str, message: &str) -> Option<String> {
        serde_json::to_string(&serde_json::json!({
            "type": "command_error",
            "action": action,
            "message": message,
        }))
        .ok()
    }

    match command.action.as_str() {
        "pause" => {
            if let Err(error) = state.player.pause().await {
                return err_json("pause", &error.to_string());
            }
        }
        "resume" => {
            if let Err(error) = state.player.resume().await {
                return err_json("resume", &error.to_string());
            }
        }
        "skip" => {
            if let Err(error) = state.player.skip().await {
                return err_json("skip", &error.to_string());
            }
        }
        "stop" => {
            if let Err(error) = state.player.stop().await {
                return err_json("stop", &error.to_string());
            }
        }
        "seek" => {
            if let Some(position_ms) = command.position_ms
                && let Err(error) = state.player.seek(position_ms).await
            {
                return err_json("seek", &error.to_string());
            }
        }
        "volume" => {
            if let Some(volume) = command.volume {
                if volume > 100 {
                    return err_json("volume", "volume must be 0-100");
                }
                if let Err(error) = state.player.set_volume(volume).await {
                    return err_json("volume", &error.to_string());
                }
                let snapshot = state.player.get_state().await;
                if let azuki_player::PlayStateInfo::Playing { ref track, .. }
                | azuki_player::PlayStateInfo::Paused { ref track, .. } = snapshot.state
                {
                    azuki_db::queries::tracks::update_track_volume(
                        &state.db,
                        &track.id,
                        i64::from(volume),
                    )
                    .await
                    .ok();
                }
            }
        }
        "loop" => {
            if let Some(mode) = command.mode {
                let mode = match mode.as_str() {
                    "one" => azuki_player::LoopMode::One,
                    "all" => azuki_player::LoopMode::All,
                    _ => azuki_player::LoopMode::Off,
                };
                if let Err(error) = state.player.set_loop(mode).await {
                    return err_json("loop", &error.to_string());
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
