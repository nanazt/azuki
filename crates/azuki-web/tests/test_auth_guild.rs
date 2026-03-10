mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{TestApp, create_test_user, get, send};

fn callback_request(state_val: &str, code: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(format!("/auth/callback?code={code}&state={state_val}"))
        .header("cookie", format!("oauth_state={state_val}"))
        .body(Body::empty())
        .unwrap()
}

async fn mount_oauth_mocks(server: &MockServer, user_id: &str, username: &str) {
    Mock::given(method("POST"))
        .and(path("/api/oauth2/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "test-access-token",
            "token_type": "Bearer"
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/users/@me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": user_id,
            "username": username,
            "avatar": null
        })))
        .mount(server)
        .await;
}

fn extract_location(resp: &axum::response::Response) -> &str {
    resp.headers().get("location").unwrap().to_str().unwrap()
}

fn has_cookie(resp: &axum::response::Response, name: &str) -> bool {
    resp.headers().get_all("set-cookie").iter().any(|v| {
        let s = v.to_str().unwrap_or("");
        s.starts_with(&format!("{name}=")) && !s.starts_with(&format!("{name}=;"))
    })
}

fn cookie_is_cleared(resp: &axum::response::Response, name: &str) -> bool {
    resp.headers().get_all("set-cookie").iter().any(|v| {
        let s = v.to_str().unwrap_or("");
        s.starts_with(&format!("{name}=;")) || s.contains("Max-Age=0")
    })
}

// #9: callback allows guild member
#[tokio::test]
async fn callback_allows_guild_member() {
    let server = MockServer::start().await;
    mount_oauth_mocks(&server, "user1", "testuser").await;

    let app = TestApp::with_guild(99999, &server.uri()).await;
    app.guild_member_cache
        .set_members(vec!["user1".to_string()]);

    let resp = send(&app.router, callback_request("test-state", "test-code")).await;

    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(extract_location(&resp), "/");
    assert!(has_cookie(&resp, "azuki_token"));
}

// #10: callback rejects non-member
#[tokio::test]
async fn callback_rejects_non_member() {
    let server = MockServer::start().await;
    mount_oauth_mocks(&server, "user1", "testuser").await;

    let app = TestApp::with_guild(99999, &server.uri()).await;
    app.guild_member_cache
        .set_members(vec!["other_user".to_string()]);

    let resp = send(&app.router, callback_request("test-state", "test-code")).await;

    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(extract_location(&resp), "/login?error=not_member");
    assert!(!has_cookie(&resp, "azuki_token"));
    assert!(cookie_is_cleared(&resp, "oauth_state"));
}

// #11: callback skips check when guild_id is zero
#[tokio::test]
async fn callback_skips_check_when_guild_id_zero() {
    let server = MockServer::start().await;
    mount_oauth_mocks(&server, "user1", "testuser").await;

    // Use new() which sets guild_id=0, but override discord_api_base
    let app = TestApp::with_guild(0, &server.uri()).await;

    let resp = send(&app.router, callback_request("test-state", "test-code")).await;

    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(extract_location(&resp), "/");
    assert!(has_cookie(&resp, "azuki_token"));
}

// #12: callback does not upsert non-member
#[tokio::test]
async fn callback_does_not_upsert_non_member() {
    let server = MockServer::start().await;
    mount_oauth_mocks(&server, "user1", "testuser").await;

    let app = TestApp::with_guild(99999, &server.uri()).await;
    app.guild_member_cache
        .set_members(vec!["other_user".to_string()]);

    let _resp = send(&app.router, callback_request("test-state", "test-code")).await;

    // Verify user was NOT inserted into DB
    let user = sqlx::query_scalar::<_, String>("SELECT id FROM users WHERE id = ?1")
        .bind("user1")
        .fetch_optional(&app.db)
        .await
        .unwrap();
    assert!(user.is_none());
}

// #13: extract_verified_user rejects non-member after cache removal
#[tokio::test]
async fn extract_verified_user_rejects_non_member() {
    let app = TestApp::with_guild(99999, "").await;

    // Create user and add to cache
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    app.guild_member_cache
        .set_members(vec!["user1".to_string()]);

    // Should succeed when user is in cache
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Remove user from cache
    app.guild_member_cache
        .set_members(vec!["other_user".to_string()]);

    // Should now return 401 (extract_user_id maps all ApiErrors to UNAUTHORIZED)
    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// #14: extract_verified_user allows member
#[tokio::test]
async fn extract_verified_user_allows_member() {
    let app = TestApp::with_guild(99999, "").await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    app.guild_member_cache
        .set_members(vec!["user1".to_string()]);

    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

// #14b: extract_verified_user fail-open when cache is empty
#[tokio::test]
async fn extract_verified_user_fail_open_empty_cache() {
    let app = TestApp::with_guild(99999, "").await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    // Cache is empty (no set_members call) -> fail-open -> 200

    let resp = send(&app.router, get("/api/queue", &cookie)).await;
    assert_eq!(resp.status(), StatusCode::OK);
}

// #14c: callback returns 502 on token exchange failure
#[tokio::test]
async fn callback_returns_502_on_token_exchange_failure() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/oauth2/token"))
        .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
        .mount(&server)
        .await;

    let app = TestApp::with_guild(99999, &server.uri()).await;
    let resp = send(&app.router, callback_request("test-state", "test-code")).await;

    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}

// #14d: callback returns 502 on user fetch failure
#[tokio::test]
async fn callback_returns_502_on_user_fetch_failure() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/oauth2/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "test-access-token",
            "token_type": "Bearer"
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api/users/@me"))
        .respond_with(ResponseTemplate::new(500).set_body_string("Internal Server Error"))
        .mount(&server)
        .await;

    let app = TestApp::with_guild(99999, &server.uri()).await;
    let resp = send(&app.router, callback_request("test-state", "test-code")).await;

    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}
