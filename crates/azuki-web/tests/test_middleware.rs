mod common;

use axum::http::StatusCode;
use common::*;

// --- Auth tests ---

#[tokio::test]
async fn no_cookie_returns_401() {
    let app = TestApp::new().await;
    let resp = send(&app.router, unauthed_get("/api/queue")).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_jwt_returns_401() {
    let app = TestApp::new().await;
    let req = get("/api/queue", "azuki_token=garbage.token.here");
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn expired_jwt_returns_401() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;

    // Create a JWT with exp in the past
    let exp_past = chrono::Utc::now().timestamp() - 3600;
    let claims = serde_json::json!({ "sub": "user1", "exp": exp_past, "tv": 0 });
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
    let token = jsonwebtoken::encode(
        &header,
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(app.jwt_secret.as_bytes()),
    )
    .unwrap();

    let req = get("/api/queue", &format!("azuki_token={token}"));
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoked_token_returns_401() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // Verify it works first
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Increment token_version to revoke
    azuki_db::queries::users::increment_token_version(&app.db, "user1")
        .await
        .unwrap();

    // Old token should now fail
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn jwt_without_tv_claim() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;

    // Increment token_version so user's tv > 0
    azuki_db::queries::users::increment_token_version(&app.db, "user1")
        .await
        .unwrap();

    // Create JWT without tv (defaults to 0 via serde default)
    let exp = chrono::Utc::now().timestamp() + 3600;
    let claims = serde_json::json!({ "sub": "user1", "exp": exp });
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
    let token = jsonwebtoken::encode(
        &header,
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(app.jwt_secret.as_bytes()),
    )
    .unwrap();

    let req = get("/api/queue", &format!("azuki_token={token}"));
    let resp = send(&app.router, req).await;
    // tv=0 (default) != user's token_version=1 → 401
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn jwt_alg_none_rejected() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;

    // Craft a token with alg=none (base64-encoded)
    let header = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        r#"{"alg":"none","typ":"JWT"}"#,
    );
    let exp = chrono::Utc::now().timestamp() + 3600;
    let payload = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        format!(r#"{{"sub":"user1","exp":{exp},"tv":0}}"#),
    );
    let token = format!("{header}.{payload}.");

    let req = get("/api/queue", &format!("azuki_token={token}"));
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// --- CSRF tests ---

#[tokio::test]
async fn missing_csrf_post_403() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let req = post_no_csrf("/api/player/pause", &cookie);
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn missing_csrf_put_403() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let req = put_no_csrf(
        "/api/preferences",
        &cookie,
        serde_json::json!({"theme": "dark"}),
    );
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn missing_csrf_delete_403() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let req = delete_no_csrf("/api/queue/0", &cookie);
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn csrf_not_required_for_get() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // GET with cookie but without X-Requested-With should still work
    let req = axum::http::Request::builder()
        .method(axum::http::Method::GET)
        .uri("/api/queue")
        .header("cookie", &cookie)
        .body(axum::body::Body::empty())
        .unwrap();
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn logout_csrf_403() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // POST /auth/logout without CSRF header (auth routes bypass CSRF middleware but logout checks manually)
    let req = post_no_csrf("/auth/logout", &cookie);
    let resp = send(&app.router, req).await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// --- Admin permissions tests ---

#[tokio::test]
async fn non_admin_admin_endpoints_403() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // Test each admin GET endpoint
    let admin_gets = [
        "/api/admin/bot-locale",
        "/api/admin/voice-channel",
        "/api/admin/history-channel",
        "/api/admin/timezone",
        "/api/admin/ytdlp",
        "/api/admin/youtube",
    ];
    for path in admin_gets {
        let resp = send(&app.router, get(path, &cookie)).await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "expected 403 for GET {path}"
        );
    }

    // Test admin PUT endpoints
    let admin_puts = [
        ("/api/admin/bot-locale", serde_json::json!({"locale": "en"})),
        (
            "/api/admin/voice-channel",
            serde_json::json!({"channel_id": "123"}),
        ),
        (
            "/api/admin/history-channel",
            serde_json::json!({"channel_id": "123"}),
        ),
        (
            "/api/admin/timezone",
            serde_json::json!({"timezone": "UTC"}),
        ),
    ];
    for (path, body) in admin_puts {
        let resp = send(&app.router, put_json(path, &cookie, body)).await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "expected 403 for PUT {path}"
        );
    }

    // Test admin POST endpoints
    let admin_posts: Vec<(&str, serde_json::Value)> = vec![
        ("/api/admin/ytdlp/check", serde_json::json!({})),
        (
            "/api/admin/youtube",
            serde_json::json!({"api_key": "test-key"}),
        ),
    ];
    for (path, body) in admin_posts {
        let resp = send(&app.router, post_json(path, &cookie, body)).await;
        assert_eq!(
            resp.status(),
            StatusCode::FORBIDDEN,
            "expected 403 for POST {path}"
        );
    }
}

#[tokio::test]
async fn admin_can_access() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "admin1", "adminuser", true).await;
    let resp = send(&app.router, get("/api/admin/bot-locale", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert!(json.get("locale").is_some());
}

// --- Security headers & CORS ---

#[tokio::test]
async fn security_headers_present() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    let resp = send(&app.router, get("/api/queue", &cookie)).await;

    assert_eq!(
        resp.headers().get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(resp.headers().get("x-frame-options").unwrap(), "DENY");
    assert!(resp.headers().get("content-security-policy").is_some());
}

#[tokio::test]
async fn cors_rejects_evil_origin() {
    let app = TestApp::new().await;
    let req = options_with_origin("/api/queue", "https://evil.com");
    let resp = send(&app.router, req).await;
    assert!(resp.headers().get("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn cors_allows_configured_origin() {
    let app = TestApp::new().await;
    let req = options_with_origin("/api/queue", "http://localhost");
    let resp = send(&app.router, req).await;
    assert_eq!(
        resp.headers()
            .get("access-control-allow-origin")
            .map(|v| v.to_str().unwrap()),
        Some("http://localhost")
    );
}

// --- Logout ---

#[tokio::test]
async fn logout_invalidates_token() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    // Logout
    let resp = send(
        &app.router,
        post_json("/auth/logout", &cookie, serde_json::json!({})),
    )
    .await;
    // Logout redirects (302)
    assert!(
        resp.status() == StatusCode::SEE_OTHER || resp.status() == StatusCode::TEMPORARY_REDIRECT,
        "expected redirect, got {}",
        resp.status()
    );

    // Old token should be invalidated (token_version incremented)
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}
