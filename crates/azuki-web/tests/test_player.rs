mod common;

use axum::http::StatusCode;
use common::*;

#[tokio::test]
async fn pause_idle_400() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json("/api/player/pause", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn resume_idle_400() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json("/api/player/resume", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn previous_idle_400() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json("/api/player/previous", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn skip_idle_ok() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json("/api/player/skip", &cookie, serde_json::json!({})),
    )
    .await;
    // Skip when idle returns 204 or 200 (no error)
    assert!(
        resp.status().is_success(),
        "expected success, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn seek_idle_400() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json(
            "/api/player/seek",
            &cookie,
            serde_json::json!({"position_ms": 5000}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn volume_valid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json(
            "/api/player/volume",
            &cookie,
            serde_json::json!({"volume": 50}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn volume_over_100_400() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json(
            "/api/player/volume",
            &cookie,
            serde_json::json!({"volume": 150}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn set_loop_mode() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    let resp = send(
        &app.router,
        post_json(
            "/api/player/loop",
            &cookie,
            serde_json::json!({"mode": "one"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify via GET /api/queue
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["loop_mode"], "one");
}

#[tokio::test]
async fn set_loop_invalid_mode_falls_back_to_off() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // First set to "one"
    send(
        &app.router,
        post_json(
            "/api/player/loop",
            &cookie,
            serde_json::json!({"mode": "one"}),
        ),
    )
    .await;

    // Then set invalid mode — should fallback to "off"
    let resp = send(
        &app.router,
        post_json(
            "/api/player/loop",
            &cookie,
            serde_json::json!({"mode": "xyz"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    let json = body_json(resp).await;
    assert_eq!(json["loop_mode"], "off");
}

#[tokio::test]
async fn get_queue_idle() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("state").is_some());
    assert!(json.get("queue").is_some());
    assert!(json.get("volume").is_some());
    assert!(json.get("loop_mode").is_some());
}

#[tokio::test]
async fn queue_add_track_not_found() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        post_json(
            "/api/queue/add",
            &cookie,
            serde_json::json!({"track_id": "nonexistent"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn queue_add_track_no_file_path() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // Seed track with no file_path
    seed_track(&app, "track1", "Test Track", "youtube", None).await;

    let resp = send(
        &app.router,
        post_json(
            "/api/queue/add",
            &cookie,
            serde_json::json!({"track_id": "track1"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn queue_add_track_success() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track_with_file(&app, "track1", "Test Track").await;

    let resp = send(
        &app.router,
        post_json(
            "/api/queue/add",
            &cookie,
            serde_json::json!({"track_id": "track1"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify track appears in queue/state
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    let json = body_json(resp).await;
    // Track should be playing (state) or in queue
    let state = &json["state"];
    let has_track = state.get("track").is_some() || !json["queue"].as_array().unwrap().is_empty();
    assert!(has_track, "track should be in state or queue");
}

#[tokio::test]
async fn queue_remove_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, delete("/api/queue/99", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn queue_move_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/queue/move",
            &cookie,
            serde_json::json!({"from": 0, "to": 99}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_queues_smoke() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/queues", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("state").is_some());
    assert!(json.get("queue").is_some());
    assert!(json.get("volume").is_some());
    assert!(json.get("loop_mode").is_some());
}

#[tokio::test]
async fn get_bot_settings() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/settings/bot", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("default_volume").is_some());
}

#[tokio::test]
async fn update_bot_settings_admin() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/settings/bot",
            &cookie,
            serde_json::json!({"default_volume": 42}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["default_volume"], 42);
}

#[tokio::test]
async fn update_bot_settings_non_admin() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/settings/bot",
            &cookie,
            serde_json::json!({"default_volume": 42}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}
