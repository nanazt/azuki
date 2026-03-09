mod common;

use axum::http::StatusCode;
use common::*;

// --- Search ---

#[tokio::test]
async fn search_youtube_no_key() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        get("/api/search?source=youtube&q=test", &cookie),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn search_history_empty() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        get("/api/search?source=history&q=test", &cookie),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn search_history_with_data() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track(&app, "track1", "My Test Song", "youtube", None).await;
    seed_history(&app, "track1", "user1").await;

    let resp = send(
        &app.router,
        get("/api/search?source=history&q=Test+Song", &cookie),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(!json["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn search_unknown_source_200() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/search?source=foo&q=test", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 0);
}

// --- History ---

#[tokio::test]
async fn history_empty() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/history", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn history_with_entries() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track(&app, "track1", "Test Track", "youtube", None).await;
    seed_history(&app, "track1", "user1").await;

    let resp = send(&app.router, get("/api/history", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(!json["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn history_pagination() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track(&app, "track1", "Track 1", "youtube", None).await;
    seed_track(&app, "track2", "Track 2", "youtube", None).await;
    seed_history(&app, "track1", "user1").await;
    seed_history(&app, "track2", "user1").await;

    // Request with limit=1
    let resp = send(&app.router, get("/api/history?limit=1", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 1);
    assert!(json["next_cursor"].is_string());

    // Use cursor for page 2
    let cursor = json["next_cursor"].as_str().unwrap();
    let resp = send(
        &app.router,
        get(&format!("/api/history?limit=1&cursor={cursor}"), &cookie),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 1);
}

// --- Uploads/Tracks ---

#[tokio::test]
async fn uploads_empty() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/uploads", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn update_track_valid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_upload_track(&app, "track1", "Old Title", "user1").await;

    let resp = send(
        &app.router,
        put_json(
            "/api/tracks/track1",
            &cookie,
            serde_json::json!({"title": "New Title"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["title"], "New Title");
}

#[tokio::test]
async fn update_track_not_owner() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user2", "otheruser", false).await;
    // Track uploaded by user1
    create_test_user(&app, "user1", "testuser", false).await;
    seed_upload_track(&app, "track1", "Title", "user1").await;

    let resp = send(
        &app.router,
        put_json(
            "/api/tracks/track1",
            &cookie,
            serde_json::json!({"title": "Stolen"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn update_track_non_upload() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track(&app, "track1", "YouTube Track", "youtube", Some("user1")).await;

    let resp = send(
        &app.router,
        put_json(
            "/api/tracks/track1",
            &cookie,
            serde_json::json!({"title": "New"}),
        ),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn update_track_no_fields() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_upload_track(&app, "track1", "Title", "user1").await;

    let resp = send(
        &app.router,
        put_json("/api/tracks/track1", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_track_non_admin() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_upload_track(&app, "track1", "Title", "user1").await;

    let resp = send(&app.router, delete("/api/tracks/track1", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn delete_track_non_upload() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    seed_track(&app, "track1", "YouTube Track", "youtube", None).await;

    let resp = send(&app.router, delete("/api/tracks/track1", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_track_admin() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    seed_upload_track(&app, "track1", "Upload Track", "admin1").await;

    let resp = send(&app.router, delete("/api/tracks/track1", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["deleted"], true);

    // Verify track is gone from DB
    let result = azuki_db::queries::tracks::get_track(&app.db, "track1").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn download_not_found() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/download/xxx", &cookie)).await;
    // DbError::NotFound or track.file_path is None → mapped to various errors
    assert!(
        resp.status() == StatusCode::NOT_FOUND
            || resp.status() == StatusCode::INTERNAL_SERVER_ERROR,
        "expected 404 or 500, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn download_path_traversal() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // Seed track with path traversal attempt
    sqlx::query(
        "INSERT INTO tracks (id, title, duration_ms, source_url, source_type, file_path, volume, created_at)
         VALUES ('evil', 'Evil', 0, 'x', 'upload', '../../etc/passwd', 50, datetime('now'))"
    )
    .execute(&app.db)
    .await
    .unwrap();

    let resp = send(&app.router, get("/api/download/evil", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// --- oEmbed ---

#[tokio::test]
async fn oembed_invalid_domain() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(
        &app.router,
        get("/api/oembed?url=https://evil.com/x", &cookie),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// --- Stats ---

#[tokio::test]
async fn stats_overview_empty() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/stats", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["total_plays"], 0);
    assert!(json.get("unique_tracks").is_some());
    assert!(json.get("streak").is_some());
    assert!(json.get("heatmap").is_some());
    assert!(json.get("trend").is_some());
    assert!(json.get("dow_activity").is_some());
}

#[tokio::test]
async fn stats_top_tracks_empty() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/stats/top-tracks", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn track_stats() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    seed_track(&app, "track1", "Test Track", "youtube", None).await;

    let resp = send(&app.router, get("/api/stats/track/track1", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("track").is_some());
}
