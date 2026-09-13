mod common;

use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Extension;
use axum::http::StatusCode;
use futures_util::task::noop_waker_ref;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};

use azuki_web::ApiError;
use azuki_web::auth::{Claims, LogoutTestGate};
use common::*;

const DAY_SECONDS: i64 = 24 * 60 * 60;

fn signed_cookie(app: &TestApp, claims: &Claims) -> String {
    let token = encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(app.jwt_secret.as_bytes()),
    )
    .unwrap();
    format!("azuki_token={token}")
}

fn issued_auth_cookie(response: &axum::response::Response) -> Option<String> {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("azuki_token=") && !value.starts_with("azuki_token=;"))
        .map(|value| value.split(';').next().unwrap().to_string())
}

fn auth_cookie_was_mutated(response: &axum::response::Response) -> bool {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.starts_with("azuki_token="))
}

fn auth_cookie_was_cleared(response: &axum::response::Response) -> bool {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.starts_with("azuki_token=;") && value.contains("Max-Age=0"))
}

#[tokio::test]
async fn refresh_preserves_session_and_issues_a_longer_lived_usable_cookie() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;
    let now = chrono::Utc::now().timestamp();
    let old_claims = Claims {
        sub: "user1".to_string(),
        exp: now + 60,
        tv: 0,
        session_started_at: now - 6 * DAY_SECONDS,
    };
    let old_cookie = signed_cookie(&app, &old_claims);

    let response = send(
        &app.router,
        post_json("/api/auth/refresh", &old_cookie, serde_json::json!({})),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let renewed_cookie = issued_auth_cookie(&response).expect("refresh must issue an auth cookie");
    let renewed_claims = azuki_web::auth::verify_jwt(
        renewed_cookie.strip_prefix("azuki_token=").unwrap(),
        &app.jwt_secret,
    )
    .unwrap();
    assert_eq!(renewed_claims.sub, old_claims.sub);
    assert_eq!(renewed_claims.tv, old_claims.tv);
    assert_eq!(
        renewed_claims.session_started_at,
        old_claims.session_started_at
    );
    assert!(renewed_claims.exp > old_claims.exp);
    let body = body_json(response).await;
    assert_eq!(body["expires_at"], renewed_claims.exp);
    assert_eq!(
        body["absolute_expires_at"],
        renewed_claims.absolute_expires_at().unwrap()
    );

    let protected = send(&app.router, get("/api/queue", &renewed_cookie)).await;
    assert_eq!(protected.status(), StatusCode::OK);
}

#[tokio::test]
async fn refresh_caps_the_cookie_and_claims_at_ninety_days() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;
    let now = chrono::Utc::now().timestamp();
    let old_claims = Claims {
        sub: "user1".to_string(),
        exp: now + 3600,
        tv: 0,
        session_started_at: now - 89 * DAY_SECONDS,
    };
    let old_cookie = signed_cookie(&app, &old_claims);

    let response = send(
        &app.router,
        post_json("/api/auth/refresh", &old_cookie, serde_json::json!({})),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("azuki_token="))
        .unwrap()
        .to_string();
    let renewed_cookie = issued_auth_cookie(&response).unwrap();
    let renewed_claims = azuki_web::auth::verify_jwt(
        renewed_cookie.strip_prefix("azuki_token=").unwrap(),
        &app.jwt_secret,
    )
    .unwrap();
    assert_eq!(
        renewed_claims.exp,
        old_claims.session_started_at + 90 * DAY_SECONDS
    );
    let max_age = set_cookie
        .split("; ")
        .find_map(|attribute| attribute.strip_prefix("Max-Age="))
        .unwrap()
        .parse::<i64>()
        .unwrap();
    assert!((1..=DAY_SECONDS).contains(&max_age));
}

#[tokio::test]
async fn expired_absolute_session_cannot_be_refreshed() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: "user1".to_string(),
        exp: now + 60,
        tv: 0,
        session_started_at: now - 90 * DAY_SECONDS,
    };
    let cookie = signed_cookie(&app, &claims);

    let response = send(
        &app.router,
        post_json("/api/auth/refresh", &cookie, serde_json::json!({})),
    )
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!auth_cookie_was_mutated(&response));
}

#[tokio::test]
async fn rejected_refreshes_never_issue_or_delete_auth_cookies() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;

    let invalid = send(
        &app.router,
        post_json(
            "/api/auth/refresh",
            "azuki_token=invalid",
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::UNAUTHORIZED);
    assert!(!auth_cookie_was_mutated(&invalid));

    let now = chrono::Utc::now().timestamp();
    let legacy_token = encode(
        &Header::new(Algorithm::HS256),
        &serde_json::json!({ "sub": "user1", "exp": now + 60, "tv": 0 }),
        &EncodingKey::from_secret(app.jwt_secret.as_bytes()),
    )
    .unwrap();
    let legacy = send(
        &app.router,
        post_json(
            "/api/auth/refresh",
            &format!("azuki_token={legacy_token}"),
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(legacy.status(), StatusCode::UNAUTHORIZED);
    assert!(!auth_cookie_was_mutated(&legacy));

    let missing_csrf = send(&app.router, post_no_csrf("/api/auth/refresh", &cookie)).await;
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);
    assert!(!auth_cookie_was_mutated(&missing_csrf));
    assert_eq!(body_json(missing_csrf).await["error"], "forbidden");

    let guild_app = TestApp::with_guild(42, "").await;
    let guild_cookie = create_test_user(&guild_app, "user1", "testuser", false).await;
    guild_app
        .guild_member_cache
        .set_members(vec!["another-user".to_string()]);
    let denied_member = send(
        &guild_app.router,
        post_json("/api/auth/refresh", &guild_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(denied_member.status(), StatusCode::FORBIDDEN);
    assert!(!auth_cookie_was_mutated(&denied_member));
}

#[tokio::test]
async fn global_logout_revokes_every_cookie_for_the_verified_version() {
    let app = TestApp::new().await;
    let first_cookie = create_test_user(&app, "user1", "testuser", false).await;
    let first_claims = azuki_web::auth::verify_jwt(
        first_cookie.strip_prefix("azuki_token=").unwrap(),
        &app.jwt_secret,
    )
    .unwrap();
    let second_claims = Claims {
        session_started_at: first_claims.session_started_at - DAY_SECONDS,
        exp: first_claims.exp,
        ..first_claims
    };
    let second_cookie = signed_cookie(&app, &second_claims);

    let response = send(
        &app.router,
        post_json("/auth/logout", &first_cookie, serde_json::json!({})),
    )
    .await;

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(auth_cookie_was_cleared(&response));
    assert_eq!(
        send(&app.router, get("/api/me", &first_cookie))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&app.router, get("/api/me", &second_cookie))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn logout_does_not_require_current_guild_membership() {
    let app = TestApp::with_guild(42, "").await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    app.guild_member_cache
        .set_members(vec!["another-user".to_string()]);
    assert_eq!(
        send(&app.router, get("/api/me", &cookie)).await.status(),
        StatusCode::FORBIDDEN
    );

    let logout = send(
        &app.router,
        post_json("/auth/logout", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
    assert!(auth_cookie_was_cleared(&logout));
}

#[tokio::test]
async fn failed_logout_update_keeps_the_cookie_and_credential_valid() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "testuser", false).await;
    sqlx::query(
        "CREATE TRIGGER reject_token_version_update
         BEFORE UPDATE OF token_version ON users
         BEGIN
             SELECT RAISE(FAIL, 'token version update rejected');
         END",
    )
    .execute(&app.db)
    .await
    .unwrap();

    let response = send(
        &app.router,
        post_json("/auth/logout", &cookie, serde_json::json!({})),
    )
    .await;

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!auth_cookie_was_mutated(&response));
    sqlx::query("DROP TRIGGER reject_token_version_update")
        .execute(&app.db)
        .await
        .unwrap();
    assert_eq!(
        send(&app.router, get("/api/me", &cookie)).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn two_validated_logouts_cannot_revoke_a_newer_login() {
    let app = TestApp::new().await;
    let old_cookie = create_test_user(&app, "user1", "testuser", false).await;
    let gate_a = Arc::new(LogoutTestGate::default());
    let gate_b = Arc::new(LogoutTestGate::default());
    let router_a = app.router.clone().layer(Extension(gate_a.clone()));
    let router_b = app.router.clone().layer(Extension(gate_b.clone()));

    let cookie_a = old_cookie.clone();
    let logout_a = tokio::spawn(async move {
        send(
            &router_a,
            post_json("/auth/logout", &cookie_a, serde_json::json!({})),
        )
        .await
    });
    gate_a.wait_until_entered().await;

    let cookie_b = old_cookie.clone();
    let logout_b = tokio::spawn(async move {
        send(
            &router_b,
            post_json("/auth/logout", &cookie_b, serde_json::json!({})),
        )
        .await
    });
    gate_b.wait_until_entered().await;

    gate_a.resume();
    let response_a = logout_a.await.unwrap();
    assert_eq!(response_a.status(), StatusCode::NO_CONTENT);
    let new_cookie = create_test_user(&app, "user1", "testuser", false).await;

    gate_b.resume();
    let response_b = logout_b.await.unwrap();
    assert_eq!(response_b.status(), StatusCode::UNAUTHORIZED);
    assert!(!auth_cookie_was_mutated(&response_b));
    assert_eq!(
        send(&app.router, get("/api/me", &new_cookie))
            .await
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn refresh_issued_before_logout_stays_revoked_when_applied_late() {
    let app = TestApp::new().await;
    let original_cookie = create_test_user(&app, "user1", "testuser", false).await;
    let refresh_response = send(
        &app.router,
        post_json("/api/auth/refresh", &original_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(refresh_response.status(), StatusCode::OK);
    let late_cookie = issued_auth_cookie(&refresh_response).unwrap();

    let logout = send(
        &app.router,
        post_json("/auth/logout", &original_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);

    assert_eq!(
        send(&app.router, get("/api/me", &late_cookie))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let late_refresh = send(
        &app.router,
        post_json("/api/auth/refresh", &late_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(late_refresh.status(), StatusCode::UNAUTHORIZED);
    assert!(!auth_cookie_was_mutated(&late_refresh));
}

#[tokio::test]
async fn missing_user_is_unauthorized_but_database_failure_is_server_error() {
    let missing_user_app = TestApp::new().await;
    let now = chrono::Utc::now().timestamp();
    let missing_cookie = signed_cookie(
        &missing_user_app,
        &Claims {
            sub: "missing".to_string(),
            exp: now + 60,
            tv: 0,
            session_started_at: now,
        },
    );
    assert_eq!(
        send(&missing_user_app.router, get("/api/me", &missing_cookie))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );

    let failed_db_app = TestApp::new().await;
    let cookie = create_test_user(&failed_db_app, "user1", "testuser", false).await;
    failed_db_app.db.close().await;
    let response = send(&failed_db_app.router, get("/api/me", &cookie)).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()["cache-control"], "no-store");
}

#[tokio::test]
async fn revalidation_rejects_claims_that_expire_while_waiting_for_the_database() {
    let app = TestApp::new().await;
    create_test_user(&app, "user1", "testuser", false).await;
    let connection_count = app.db.options().get_max_connections();
    let mut connections = Vec::with_capacity(connection_count as usize);
    for _ in 0..connection_count {
        connections.push(app.db.acquire().await.unwrap());
    }

    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: "user1".to_string(),
        exp: now + 1,
        tv: 0,
        session_started_at: now,
    };
    let mut revalidation = Box::pin(azuki_web::auth::revalidate_claims(&claims, &app.state));
    let mut context = Context::from_waker(noop_waker_ref());
    assert!(matches!(
        revalidation.as_mut().poll(&mut context),
        Poll::Pending
    ));

    tokio::time::sleep(Duration::from_secs(2)).await;
    drop(connections);

    assert!(matches!(revalidation.await, Err(ApiError::Unauthorized)));
}
