use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, SameSite};
use axum_extra::extract::CookieJar;
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use tracing::error;

use crate::WebState;

const JWT_EXPIRY_HOURS: i64 = 24;
const OAUTH_STATE_COOKIE: &str = "oauth_state";
const JWT_COOKIE: &str = "azuki_token";

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
    #[serde(default)]
    pub tv: i64,
}

#[derive(Deserialize)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

#[derive(Deserialize)]
struct DiscordTokenResponse {
    access_token: String,
    #[allow(dead_code)]
    token_type: String,
}

#[derive(Deserialize)]
struct DiscordUser {
    id: String,
    username: String,
    avatar: Option<String>,
}

pub fn create_jwt(
    user_id: &str,
    secret: &str,
    token_version: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    let exp = Utc::now().timestamp() + JWT_EXPIRY_HOURS * 3600;
    let claims = Claims {
        sub: user_id.to_string(),
        exp,
        tv: token_version,
    };
    let header = Header::new(Algorithm::HS256);
    encode(&header, &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["sub", "exp"]);
    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &validation)?;
    Ok(data.claims)
}

pub async fn login(State(state): State<WebState>, jar: CookieJar) -> impl IntoResponse {
    let oauth_state = uuid::Uuid::new_v4().to_string();
    let is_secure = state.discord_redirect_uri.starts_with("https://");

    let state_cookie = Cookie::build((OAUTH_STATE_COOKIE, oauth_state.clone()))
        .http_only(true)
        .secure(is_secure)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(300))
        .path("/")
        .build();

    let url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={}&redirect_uri={}&response_type=code&scope=identify&state={}",
        state.discord_client_id,
        urlencoding::encode(&state.discord_redirect_uri),
        oauth_state,
    );

    (jar.add(state_cookie), Redirect::temporary(&url))
}

pub async fn callback(
    State(state): State<WebState>,
    jar: CookieJar,
    Query(params): Query<OAuthCallback>,
) -> Response {
    // Validate CSRF state
    let stored_state = match jar.get(OAUTH_STATE_COOKIE) {
        Some(c) => c.value().to_string(),
        None => {
            return Redirect::temporary("/auth/login").into_response();
        }
    };

    if stored_state != params.state {
        return (StatusCode::BAD_REQUEST, "oauth state mismatch").into_response();
    }

    // Exchange code for token
    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://discord.com/api/oauth2/token")
        .form(&[
            ("client_id", state.discord_client_id.as_str()),
            ("client_secret", state.discord_client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", &params.code),
            ("redirect_uri", &state.discord_redirect_uri),
        ])
        .send()
        .await;

    let token_resp = match token_resp {
        Ok(r) => r,
        Err(e) => {
            error!("discord token exchange failed: {e}");
            return (StatusCode::BAD_GATEWAY, "discord token exchange failed").into_response();
        }
    };

    let token_data: DiscordTokenResponse = match token_resp.json().await {
        Ok(d) => d,
        Err(e) => {
            error!("failed to parse discord token: {e}");
            return (StatusCode::BAD_GATEWAY, "invalid discord response").into_response();
        }
    };

    // Get user info
    let user_resp = client
        .get("https://discord.com/api/users/@me")
        .bearer_auth(&token_data.access_token)
        .send()
        .await;

    let user: DiscordUser = match user_resp {
        Ok(r) => match r.json().await {
            Ok(u) => u,
            Err(e) => {
                error!("failed to parse discord user: {e}");
                return (StatusCode::BAD_GATEWAY, "invalid user response").into_response();
            }
        },
        Err(e) => {
            error!("discord user fetch failed: {e}");
            return (StatusCode::BAD_GATEWAY, "user fetch failed").into_response();
        }
    };

    // Upsert user in DB
    let avatar_url = user.avatar.as_ref().map(|hash| {
        format!("https://cdn.discordapp.com/avatars/{}/{hash}.png", user.id)
    });

    let db_user = match azuki_db::queries::users::upsert_user(
        &state.db,
        &user.id,
        &user.username,
        avatar_url.as_deref(),
    )
    .await
    {
        Ok(u) => u,
        Err(e) => {
            error!("failed to upsert user: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };

    // Create JWT
    let jwt = match create_jwt(&user.id, &state.jwt_secret, db_user.token_version) {
        Ok(t) => t,
        Err(e) => {
            error!("failed to create JWT: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "token creation failed").into_response();
        }
    };

    // Set JWT cookie and clear oauth state cookie
    let is_secure = state.discord_redirect_uri.starts_with("https://");
    let jwt_cookie = Cookie::build((JWT_COOKIE, jwt))
        .http_only(true)
        .secure(is_secure)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::hours(JWT_EXPIRY_HOURS))
        .path("/")
        .build();

    let clear_state = Cookie::build((OAUTH_STATE_COOKIE, ""))
        .path("/")
        .max_age(cookie::time::Duration::ZERO)
        .build();

    let jar = jar.add(jwt_cookie).add(clear_state);

    (jar, Redirect::temporary("/")).into_response()
}

pub async fn extract_user_id(jar: &CookieJar, state: &WebState) -> Result<String, StatusCode> {
    let token = jar
        .get(JWT_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let claims = verify_jwt(&token, &state.jwt_secret).map_err(|_| StatusCode::UNAUTHORIZED)?;

    // Validate token_version
    let user = azuki_db::queries::users::get_user(&state.db, &claims.sub)
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;

    if claims.tv != user.token_version {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(claims.sub)
}

pub async fn logout(
    State(state): State<WebState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Response {
    // Verify X-Requested-With header manually (auth_routes bypass CSRF middleware)
    let has_csrf = headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        == Some("XMLHttpRequest");
    if !has_csrf {
        return (StatusCode::FORBIDDEN, "missing CSRF header").into_response();
    }

    // Increment token_version to invalidate all existing JWTs
    if let Ok(user_id) = extract_user_id(&jar, &state).await {
        let _ = azuki_db::queries::users::increment_token_version(&state.db, &user_id).await;
    }

    // Clear JWT cookie
    let clear_cookie = Cookie::build((JWT_COOKIE, ""))
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::ZERO)
        .path("/")
        .build();

    (jar.add(clear_cookie), Redirect::temporary("/login")).into_response()
}

pub fn auth_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/auth/login", axum::routing::get(login))
        .route("/auth/callback", axum::routing::get(callback))
        .route("/auth/logout", axum::routing::post(logout))
}

mod urlencoding {
    pub fn encode(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }
}
