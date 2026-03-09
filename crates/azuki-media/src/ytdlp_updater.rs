use std::path::Path;

use sha2::{Digest, Sha256};
use tracing::{debug, info};
use url::Url;

use crate::MediaError;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReleaseInfo {
    pub version: String,
    pub download_url: String,
    pub checksum_url: String,
}

fn platform_asset_name() -> Result<&'static str, MediaError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("yt-dlp_linux"),
        ("linux", "aarch64") => Ok("yt-dlp_linux_aarch64"),
        ("macos", _) => Ok("yt-dlp_macos"),
        (os, arch) => Err(MediaError::YtDlp(format!(
            "unsupported platform: {os}/{arch}"
        ))),
    }
}

fn validate_url(url_str: &str) -> Result<(), MediaError> {
    let url = Url::parse(url_str).map_err(|e| MediaError::YtDlp(format!("invalid URL: {e}")))?;
    if url.scheme() != "https" {
        return Err(MediaError::YtDlp("URL must use HTTPS".to_string()));
    }
    let host = url.host_str().unwrap_or("");
    if host != "github.com" && host != "objects.githubusercontent.com" {
        return Err(MediaError::YtDlp(format!("disallowed host: {host}")));
    }
    Ok(())
}

pub async fn get_latest_release() -> Result<ReleaseInfo, MediaError> {
    let asset_name = platform_asset_name()?;

    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header("User-Agent", "azuki-bot")
        .send()
        .await
        .map_err(|e| MediaError::YtDlp(format!("GitHub API request failed: {e}")))?
        .error_for_status()
        .map_err(|e| MediaError::YtDlp(format!("GitHub API error: {e}")))?
        .json()
        .await
        .map_err(|e| MediaError::YtDlp(format!("GitHub API parse error: {e}")))?;

    let version = resp["tag_name"]
        .as_str()
        .ok_or_else(|| MediaError::YtDlp("missing tag_name".to_string()))?
        .to_string();

    let assets = resp["assets"]
        .as_array()
        .ok_or_else(|| MediaError::YtDlp("missing assets".to_string()))?;

    let download_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some(asset_name))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or_else(|| MediaError::YtDlp(format!("asset {asset_name} not found")))?
        .to_string();

    let checksum_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("SHA2-256SUMS"))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or_else(|| MediaError::YtDlp("SHA2-256SUMS not found".to_string()))?
        .to_string();

    Ok(ReleaseInfo {
        version,
        download_url,
        checksum_url,
    })
}

pub async fn download_binary(release: &ReleaseInfo, dest_path: &Path) -> Result<(), MediaError> {
    validate_url(&release.download_url)?;
    validate_url(&release.checksum_url)?;

    let asset_name = platform_asset_name()?;

    let client = reqwest::Client::builder()
        .user_agent("azuki-bot")
        .build()
        .map_err(|e| MediaError::YtDlp(format!("HTTP client error: {e}")))?;

    // Download SHA2-256SUMS
    debug!("downloading checksums from {}", release.checksum_url);
    let checksums_text = client
        .get(&release.checksum_url)
        .send()
        .await
        .map_err(|e| MediaError::YtDlp(format!("checksum download failed: {e}")))?
        .error_for_status()
        .map_err(|e| MediaError::YtDlp(format!("checksum download error: {e}")))?
        .text()
        .await
        .map_err(|e| MediaError::YtDlp(format!("checksum read failed: {e}")))?;

    let expected_hash = checksums_text
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            if name.trim_start_matches('*') == asset_name {
                Some(hash.to_lowercase())
            } else {
                None
            }
        })
        .ok_or_else(|| MediaError::YtDlp(format!("no checksum found for {asset_name}")))?;

    // Ensure parent directory exists
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| MediaError::YtDlp(format!("failed to create bin dir: {e}")))?;
    }

    let tmp_path = dest_path.with_extension("tmp");

    // Download binary
    debug!("downloading binary from {}", release.download_url);
    let resp = client
        .get(&release.download_url)
        .send()
        .await
        .map_err(|e| MediaError::YtDlp(format!("binary download failed: {e}")))?
        .error_for_status()
        .map_err(|e| MediaError::YtDlp(format!("binary download error: {e}")))?;

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| MediaError::YtDlp(format!("binary read failed: {e}")))?;

    // SHA256 verify
    let actual_hash = hex::encode(Sha256::digest(&bytes));
    if actual_hash != expected_hash {
        return Err(MediaError::YtDlp(format!(
            "checksum mismatch: expected {expected_hash}, got {actual_hash}"
        )));
    }

    // Write to tmp file
    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| MediaError::YtDlp(format!("write failed: {e}")))?;

    // chmod 0o755
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| MediaError::YtDlp(format!("chmod failed: {e}")))?;
    }

    // Atomic rename
    if let Err(e) = tokio::fs::rename(&tmp_path, dest_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(MediaError::YtDlp(format!("rename failed: {e}")));
    }

    info!(
        "yt-dlp {} installed to {}",
        release.version,
        dest_path.display()
    );
    Ok(())
}
