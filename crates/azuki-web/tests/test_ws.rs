mod common;

use axum::http::StatusCode;
use common::*;

// WebSocketUpgrade extractor requires a real upgradeable HTTP connection,
// which tower::oneshot cannot provide. These tests verify that non-WebSocket
// requests to /ws are rejected (not 200/101).

#[tokio::test]
async fn ws_plain_get_rejected() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // Plain GET without WS upgrade headers
    let req = get("/ws", &cookie);
    let resp = send(&app.router, req).await;
    // Should not succeed — extractor rejects with 400 (missing upgrade)
    assert!(
        !resp.status().is_success(),
        "expected rejection, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn ws_upgrade_without_real_connection_rejected() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // Even with correct headers, oneshot can't provide upgradeable connection
    let req = axum::http::Request::builder()
        .method(axum::http::Method::GET)
        .uri("/ws")
        .header("cookie", &cookie)
        .header("origin", "http://localhost")
        .header("upgrade", "websocket")
        .header("connection", "Upgrade")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = send(&app.router, req).await;
    // 426 Upgrade Required — extractor rejects non-upgradeable connections
    assert_eq!(resp.status(), StatusCode::UPGRADE_REQUIRED);
}

#[tokio::test]
async fn ws_no_auth_not_success() {
    let app = TestApp::new().await;
    // No cookie, no origin
    let req = axum::http::Request::builder()
        .method(axum::http::Method::GET)
        .uri("/ws")
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = send(&app.router, req).await;
    assert!(
        !resp.status().is_success(),
        "expected rejection, got {}",
        resp.status()
    );
}
