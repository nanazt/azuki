mod common;

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use common::*;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{COOKIE, ORIGIN};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use azuki_web::auth::{AuthRevocation, Claims};
use azuki_web::build_router;
use azuki_web::events::{WebEvent, publish_web_event};

type ClientSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct RunningServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl RunningServer {
    async fn start(router: Router) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { address, task }
    }

    fn http_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn connect(
    server: &RunningServer,
    cookie: &str,
) -> Result<ClientSocket, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{}/ws", server.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, "http://localhost".parse().unwrap());
    request
        .headers_mut()
        .insert(COOKIE, cookie.parse().unwrap());
    connect_async(request).await.map(|(socket, _)| socket)
}

async fn next_json(socket: &mut ClientSocket) -> serde_json::Value {
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("timed out waiting for WebSocket message")
        .expect("WebSocket closed before message")
        .expect("WebSocket read failed");
    match message {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected text message, got {other:?}"),
    }
}

async fn next_close_code_with_timeout(socket: &mut ClientSocket, wait: Duration) -> u16 {
    loop {
        let message = tokio::time::timeout(wait, socket.next())
            .await
            .expect("timed out waiting for WebSocket close")
            .expect("WebSocket ended without a close frame")
            .expect("WebSocket read failed");
        match message {
            Message::Close(Some(frame)) => return frame.code.into(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            _ => {}
        }
    }
}

async fn next_close_code(socket: &mut ClientSocket) -> u16 {
    next_close_code_with_timeout(socket, Duration::from_secs(3)).await
}

fn assert_snapshot(value: &serde_json::Value) {
    assert_eq!(value["type"], "state_snapshot");
    let state = value.get("state").expect("player state payload");
    assert!(state.get("playback_suspended").is_some());
    assert!(state.get("playback_revision").is_some());
    assert!(value.get("active_downloads").is_some());
}

fn assert_bot_status(value: &serde_json::Value) {
    assert_eq!(value["type"], "bot_status");
    let status = value.get("status").expect("bot status payload");
    for field in [
        "revision",
        "status",
        "target_voice_channel_id",
        "restart_in_progress",
        "restart_available_at",
        "next_retry_at",
        "last_error",
        "last_checkpoint_at",
        "persistence_error",
    ] {
        assert!(
            status.get(field).is_some(),
            "missing bot status field {field}"
        );
    }
}

fn cookie_for_claims(secret: &str, claims: &Claims) -> String {
    let token = encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap();
    format!("azuki_token={token}")
}

fn assert_handshake_status(error: WsError, expected: StatusCode) {
    match error {
        WsError::Http(response) => assert_eq!(response.status(), expected),
        other => panic!("expected HTTP {expected} handshake rejection, got {other:?}"),
    }
}

#[test]
fn output_recovery_events_keep_their_transport_meaning() {
    let suspended: WebEvent =
        azuki_player::PlayerEvent::OutputSuspended { position_ms: 4_200 }.into();
    let resumed: WebEvent = azuki_player::PlayerEvent::OutputResumed { position_ms: 4_500 }.into();

    assert_eq!(
        serde_json::to_value(suspended).unwrap(),
        serde_json::json!({
            "type": "output_suspended",
            "position_ms": 4_200,
        })
    );
    assert_eq!(
        serde_json::to_value(resumed).unwrap(),
        serde_json::json!({
            "type": "output_resumed",
            "position_ms": 4_500,
        })
    );
}

#[tokio::test]
async fn valid_connection_receives_snapshot_and_ignores_unrelated_revocations() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();

    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    app.state
        .auth_revocations
        .send(AuthRevocation {
            user_id: "other-user".to_string(),
            token_version: 100,
        })
        .unwrap();
    app.state
        .auth_revocations
        .send(AuthRevocation {
            user_id: "user1".to_string(),
            token_version: 0,
        })
        .unwrap();
    socket
        .send(Message::Text(r#"{"action":"sync"}"#.into()))
        .await
        .unwrap();

    let sync_snapshot = next_json(&mut socket).await;
    assert_eq!(sync_snapshot["seq"], 0);
    assert_snapshot(&sync_snapshot["event"]);
    assert_bot_status(&next_json(&mut socket).await);
}

#[tokio::test]
async fn reconnect_and_sync_receive_latest_bot_status_without_advancing_the_global_sequence() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    *app.state.web_seq.lock().unwrap() = 7;
    let server = RunningServer::start(app.router.clone()).await;

    let mut first_socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut first_socket).await);
    let initial_status = next_json(&mut first_socket).await;
    assert_bot_status(&initial_status);
    assert_eq!(initial_status["status"]["revision"], 0);

    let _ = app.state.bot_control.restart().await.unwrap();

    let mut reconnected = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut reconnected).await);
    let reconnect_status = next_json(&mut reconnected).await;
    assert_bot_status(&reconnect_status);
    assert_eq!(reconnect_status["status"]["revision"], 1);
    assert_eq!(reconnect_status["status"]["status"], "restarting");

    publish_web_event(
        &app.state.web_tx,
        &app.state.web_seq,
        WebEvent::BotStatus {
            status: app.state.bot_control.status(),
        },
    );
    let live_status = next_json(&mut reconnected).await;
    assert_eq!(live_status["seq"], 8);
    assert_bot_status(&live_status["event"]);
    assert_eq!(live_status["event"]["status"]["revision"], 1);

    reconnected
        .send(Message::Text(r#"{"action":"sync"}"#.into()))
        .await
        .unwrap();
    let sync_snapshot = next_json(&mut reconnected).await;
    assert_eq!(sync_snapshot["seq"], 8);
    assert_snapshot(&sync_snapshot["event"]);
    let sync_status = next_json(&mut reconnected).await;
    assert_bot_status(&sync_status);
    assert_eq!(sync_status["status"]["revision"], 1);
    assert_eq!(*app.state.web_seq.lock().unwrap(), 8);
}

#[tokio::test]
async fn logout_closes_existing_socket_rejects_old_handshake_and_spares_new_version() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut old_socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut old_socket).await);
    assert_bot_status(&next_json(&mut old_socket).await);

    let response = reqwest::Client::new()
        .post(server.http_url("/auth/logout"))
        .header("cookie", &cookie)
        .header("x-requested-with", "XMLHttpRequest")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(next_close_code(&mut old_socket).await, 4001);

    let error = connect(&server, &cookie).await.unwrap_err();
    assert_handshake_status(error, StatusCode::UNAUTHORIZED);

    let new_cookie = create_test_user(&app, "user1", "testuser", false).await;
    let mut new_socket = connect(&server, &new_cookie).await.unwrap();
    assert_snapshot(&next_json(&mut new_socket).await);
    assert_bot_status(&next_json(&mut new_socket).await);

    app.state
        .auth_revocations
        .send(AuthRevocation {
            user_id: "user1".to_string(),
            token_version: 1,
        })
        .unwrap();
    new_socket
        .send(Message::Text(r#"{"action":"sync"}"#.into()))
        .await
        .unwrap();
    let sync_snapshot = next_json(&mut new_socket).await;
    assert_eq!(sync_snapshot["seq"], 0);
    assert_snapshot(&sync_snapshot["event"]);
    assert_bot_status(&next_json(&mut new_socket).await);
}

#[tokio::test]
async fn socket_closes_at_credential_expiry() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;
    let now = chrono::Utc::now().timestamp();
    let cookie = cookie_for_claims(
        &app.jwt_secret,
        &Claims {
            sub: "user1".to_string(),
            exp: now + 2,
            tv: 0,
            session_started_at: now - 1,
        },
    );
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();

    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);
    assert_eq!(next_close_code(&mut socket).await, 4001);
}

#[tokio::test]
async fn authentication_database_failure_closes_socket_as_transient() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    app.db.close().await;
    let _ = socket
        .send(Message::Text(r#"{"action":"sync"}"#.into()))
        .await;

    assert_eq!(next_close_code(&mut socket).await, 1011);
}

#[tokio::test]
async fn sync_command_revalidates_before_periodic_fallback() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    let new_version =
        azuki_db::queries::users::increment_token_version_if_current(&app.db, "user1", 0)
            .await
            .unwrap();
    assert_eq!(new_version, Some(1));
    socket
        .send(Message::Text(r#"{"action":"sync"}"#.into()))
        .await
        .unwrap();

    let close_code = tokio::time::timeout(Duration::from_millis(750), next_close_code(&mut socket))
        .await
        .expect("sync command waited for periodic authentication recheck");
    assert_eq!(close_code, 4001);
}

#[tokio::test]
async fn handshake_preserves_authentication_error_statuses() {
    let unauthorized = TestApp::new().await;
    let unauthorized_server = RunningServer::start(unauthorized.router.clone()).await;
    let error = connect(&unauthorized_server, "azuki_token=invalid")
        .await
        .unwrap_err();
    assert_handshake_status(error, StatusCode::UNAUTHORIZED);

    let forbidden = TestApp::with_guild(42, "").await;
    let forbidden_cookie = create_test_user(&forbidden, "user1", "testuser", false).await;
    forbidden
        .guild_member_cache
        .set_members(["another-user".to_string()]);
    let forbidden_server = RunningServer::start(forbidden.router.clone()).await;
    let error = connect(&forbidden_server, &forbidden_cookie)
        .await
        .unwrap_err();
    assert_handshake_status(error, StatusCode::FORBIDDEN);

    let unavailable = TestApp::new().await;
    let unavailable_cookie = create_test_user(&unavailable, "user1", "testuser", false).await;
    unavailable.db.close().await;
    let unavailable_server = RunningServer::start(unavailable.router.clone()).await;
    let error = connect(&unavailable_server, &unavailable_cookie)
        .await
        .unwrap_err();
    assert_handshake_status(error, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test(flavor = "current_thread")]
async fn lagged_revocation_stream_revalidates_lost_target_notice() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    let new_version =
        azuki_db::queries::users::increment_token_version_if_current(&app.db, "user1", 0)
            .await
            .unwrap();
    assert_eq!(new_version, Some(1));
    app.state
        .auth_revocations
        .send(AuthRevocation {
            user_id: "user1".to_string(),
            token_version: 1,
        })
        .unwrap();
    for index in 0..200 {
        app.state
            .auth_revocations
            .send(AuthRevocation {
                user_id: format!("unrelated-{index}"),
                token_version: 1,
            })
            .unwrap();
    }

    assert_eq!(next_close_code(&mut socket).await, 4001);
}

#[tokio::test(flavor = "current_thread")]
async fn lagged_event_stream_recovers_with_sequenced_snapshot() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let snapshot_event = WebEvent::StateSnapshot {
        state: app.state.player.get_state().await,
        active_downloads: Vec::new(),
    };
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);
    let _ = app.state.bot_control.restart().await.unwrap();

    for _ in 1..=80 {
        publish_web_event(
            &app.state.web_tx,
            &app.state.web_seq,
            snapshot_event.clone(),
        );
    }

    let recovery = next_json(&mut socket).await;
    assert_eq!(recovery["seq"], 80);
    assert_snapshot(&recovery["event"]);
    let recovered_bot = next_json(&mut socket).await;
    assert_bot_status(&recovered_bot);
    assert_eq!(recovered_bot["status"]["revision"], 1);
    assert_eq!(recovered_bot["status"]["status"], "restarting");
}

#[tokio::test]
async fn periodic_recheck_catches_logout_from_another_revocation_channel() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let first_server = RunningServer::start(app.router.clone()).await;

    let mut second_state = app.state.clone();
    second_state.auth_revocations = tokio::sync::broadcast::channel(16).0;
    second_state.web_shutdown = tokio_util::sync::CancellationToken::new();
    let second_server = RunningServer::start(build_router(second_state)).await;

    let mut socket = connect(&first_server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    let response = reqwest::Client::new()
        .post(second_server.http_url("/auth/logout"))
        .header("cookie", &cookie)
        .header("x-requested-with", "XMLHttpRequest")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        next_close_code_with_timeout(&mut socket, Duration::from_secs(35)).await,
        4001
    );
}

#[tokio::test]
async fn web_shutdown_closes_live_socket_gracefully() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;
    let mut socket = connect(&server, &cookie).await.unwrap();
    assert_snapshot(&next_json(&mut socket).await);
    assert_bot_status(&next_json(&mut socket).await);

    app.state.web_shutdown.cancel();

    assert_eq!(next_close_code(&mut socket).await, 1001);
}

#[tokio::test]
async fn logout_while_upgrade_waits_for_database_cannot_open_revoked_socket() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let server = RunningServer::start(app.router.clone()).await;

    let mut held_connections = Vec::new();
    for _ in 0..app.db.options().get_max_connections() {
        held_connections.push(app.db.acquire().await.unwrap());
    }

    let address = server.address;
    let cookie_for_connect = cookie.clone();
    let connection = tokio::spawn(async move {
        let mut request = format!("ws://{address}/ws").into_client_request().unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, "http://localhost".parse().unwrap());
        request
            .headers_mut()
            .insert(COOKIE, cookie_for_connect.parse().unwrap());
        connect_async(request).await
    });

    tokio::time::timeout(Duration::from_secs(2), async {
        while app.state.auth_revocations.receiver_count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("upgrade did not subscribe before authentication");

    let new_version: i64 = sqlx::query_scalar(
        "UPDATE users
         SET token_version = token_version + 1
         WHERE id = ?1 AND token_version = ?2
         RETURNING token_version",
    )
    .bind("user1")
    .bind(0_i64)
    .fetch_one(&mut *held_connections[0])
    .await
    .unwrap();
    app.state
        .auth_revocations
        .send(AuthRevocation {
            user_id: "user1".to_string(),
            token_version: new_version,
        })
        .unwrap();
    drop(held_connections);

    let error = connection.await.unwrap().unwrap_err();
    assert_handshake_status(error, StatusCode::UNAUTHORIZED);
}
