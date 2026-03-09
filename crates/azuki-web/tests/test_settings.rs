mod common;

use axum::http::StatusCode;
use common::*;

// --- User preferences ---

#[tokio::test]
async fn get_me() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/me", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["id"], "user1");
    assert_eq!(json["username"], "testuser");
    assert!(json.get("is_admin").is_some());
}

#[tokio::test]
async fn get_me_horizontal_auth() {
    let app = TestApp::new().await;
    let cookie_a = create_test_user(&app, "userA", "Alice", false).await;
    create_test_user(&app, "userB", "Bob", false).await;

    let resp = send(&app.router, get("/api/me", &cookie_a)).await;
    let json = body_json(resp).await;
    assert_eq!(json["id"], "userA");
    assert_eq!(json["username"], "Alice");
}

#[tokio::test]
async fn get_preferences_default() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/preferences", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("theme").is_some());
    assert!(json.get("locale").is_some());
}

#[tokio::test]
async fn update_preferences() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/preferences",
            &cookie,
            serde_json::json!({"theme": "light", "locale": "en"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["theme"], "light");
    assert_eq!(json["locale"], "en");
}

#[tokio::test]
async fn update_preferences_invalid_theme() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/preferences",
            &cookie,
            serde_json::json!({"theme": "neon"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn update_preferences_invalid_locale() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/preferences",
            &cookie,
            serde_json::json!({"locale": "fr"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn preferences_round_trip() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // Update
    send(
        &app.router,
        put_json(
            "/api/preferences",
            &cookie,
            serde_json::json!({"theme": "light", "locale": "en"}),
        ),
    )
    .await;

    // Read back
    let resp = send(&app.router, get("/api/preferences", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["theme"], "light");
    assert_eq!(json["locale"], "en");
}

// --- Admin - Bot locale ---

#[tokio::test]
async fn bot_locale_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/bot-locale", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["locale"], "ko");
}

#[tokio::test]
async fn bot_locale_set() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/bot-locale",
            &cookie,
            serde_json::json!({"locale": "en"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn bot_locale_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/bot-locale",
            &cookie,
            serde_json::json!({"locale": "fr"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// --- Admin - Voice/History/Web/Timezone ---

#[tokio::test]
async fn voice_channel_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/voice-channel", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn voice_channel_set() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/voice-channel",
            &cookie,
            serde_json::json!({"channel_id": "123456789"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn history_channel_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/history-channel", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn history_channel_set() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/history-channel",
            &cookie,
            serde_json::json!({"channel_id": "123456789"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn history_channel_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/history-channel",
            &cookie,
            serde_json::json!({"channel_id": "not-a-number"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn web_base_url_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/web-base-url", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn web_base_url_set() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/web-base-url",
            &cookie,
            serde_json::json!({"url": "https://azuki.example.com"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn web_base_url_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/web-base-url",
            &cookie,
            serde_json::json!({"url": "ftp://a"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn timezone_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/timezone", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["timezone"], "UTC");
}

#[tokio::test]
async fn timezone_set() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/timezone",
            &cookie,
            serde_json::json!({"timezone": "Asia/Seoul"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn timezone_invalid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(
        &app.router,
        put_json(
            "/api/admin/timezone",
            &cookie,
            serde_json::json!({"timezone": "Mars/Olympus"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}
