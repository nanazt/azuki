use std::path::{Path, PathBuf};

use serde::Deserialize;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tracing::warn;

use crate::types::TrackMeta;
use crate::ytdlp_updater::ReleaseInfo;
use crate::MediaError;

#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub stage: DownloadStage,
    pub percent: f64,
    pub speed_bps: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStage {
    Resolving,
    Downloading,
    Converting,
}

const PERMITS: u32 = 3;
static SEMAPHORE: Semaphore = Semaphore::const_new(PERMITS as usize);

/// Separate semaphore for overflow refill/pre-download (2 permits)
pub static REFILL_SEMAPHORE: Semaphore = Semaphore::const_new(2);

#[derive(Debug, Clone)]
pub struct FlatPlaylistEntry {
    pub id: String,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub url: String,
    pub thumbnail: Option<String>,
    pub is_unavailable: bool,
}

#[derive(Debug, Deserialize)]
struct FlatPlaylistJson {
    id: Option<String>,
    title: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    url: Option<String>,
    webpage_url: Option<String>,
    thumbnail: Option<String>,
    playlist_title: Option<String>,
    playlist_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YtDlpOutput {
    id: Option<String>,
    title: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    entries: Option<Vec<YtDlpOutput>>,
}

pub struct YtDlp {
    media_dir: PathBuf,
    managed_bin: PathBuf,
    effective_bin: std::sync::Mutex<PathBuf>,
}

impl YtDlp {
    pub fn new(media_dir: impl Into<PathBuf>, data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        let managed_bin = data_dir.join("bin").join("yt-dlp");
        Self {
            media_dir: media_dir.into(),
            effective_bin: std::sync::Mutex::new(managed_bin.clone()),
            managed_bin,
        }
    }

    pub fn bin_path(&self) -> PathBuf {
        self.effective_bin.lock().unwrap().clone()
    }

    pub fn is_managed(&self) -> bool {
        *self.effective_bin.lock().unwrap() == self.managed_bin
    }

    pub async fn version(&self) -> Result<String, MediaError> {
        let output = Command::new(self.bin_path())
            .arg("--version")
            .output()
            .await
            .map_err(|e| MediaError::YtDlp(format!("failed to get version: {e}")))?;
        if !output.status.success() {
            return Err(MediaError::YtDlp("yt-dlp --version failed".to_string()));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub async fn ensure_installed(&self) -> Result<(), MediaError> {
        // 1. Check managed binary
        if self.managed_bin.exists() {
            let output = Command::new(&self.managed_bin)
                .arg("--version")
                .output()
                .await;
            if output.is_ok_and(|o| o.status.success()) {
                *self.effective_bin.lock().unwrap() = self.managed_bin.clone();
                return Ok(());
            }
        }

        // 2. Fallback to PATH
        let output = Command::new("yt-dlp").arg("--version").output().await;
        if output.is_ok_and(|o| o.status.success()) {
            warn!("using system yt-dlp from PATH");
            *self.effective_bin.lock().unwrap() = PathBuf::from("yt-dlp");
            return Ok(());
        }

        // 3. Auto-download
        let release = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            crate::ytdlp_updater::get_latest_release(),
        )
        .await
        .map_err(|_| MediaError::YtDlp("release check timed out".to_string()))??;

        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            crate::ytdlp_updater::download_binary(&release, &self.managed_bin),
        )
        .await
        .map_err(|_| MediaError::YtDlp("download timed out".to_string()))??;

        *self.effective_bin.lock().unwrap() = self.managed_bin.clone();
        Ok(())
    }

    pub async fn update(&self, release: &ReleaseInfo) -> Result<(), MediaError> {
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            SEMAPHORE.acquire_many(PERMITS),
        )
        .await
        .map_err(|_| MediaError::YtDlp("timeout waiting for in-flight tasks".to_string()))?
        .map_err(|_| MediaError::YtDlp("semaphore closed".to_string()))?;

        let result = crate::ytdlp_updater::download_binary(release, &self.managed_bin).await;

        drop(permit);
        result
    }

    fn sanitize_query(input: &str) -> String {
        input
            .chars()
            .filter(|c| !matches!(c, ';' | '&' | '|' | '$' | '`' | '(' | ')' | '{' | '}' | '<' | '>' | '!' | '\n' | '\r'))
            .collect()
    }

    pub async fn download(&self, url: &str) -> Result<(PathBuf, TrackMeta), MediaError> {
        self.download_with_progress(url, |_| {}).await
    }

    pub async fn download_with_progress(
        &self,
        url: &str,
        mut on_progress: impl FnMut(DownloadProgress),
    ) -> Result<(PathBuf, TrackMeta), MediaError> {
        let _permit = SEMAPHORE.acquire().await.map_err(|_| {
            MediaError::YtDlp("semaphore closed".to_string())
        })?;

        let sanitized_url = Self::sanitize_query(url);
        let output_template = self.media_dir.join("%(id)s.%(ext)s").to_string_lossy().to_string();

        let mut child = Command::new(self.bin_path())
            .args([
                "--no-exec",
                "--print-json",
                "--no-warnings",
                "--progress",
                "--newline",
                "-x",
                "--audio-format", "opus",
                "--audio-quality", "0",
                "-o", &output_template,
                "--",
                &sanitized_url,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| MediaError::YtDlp(format!("failed to run yt-dlp: {e}")))?;

        // Read stdout and stderr concurrently to avoid deadlocks
        let stderr_handle = child.stderr.take().unwrap();
        let stdout_handle = child.stdout.take().unwrap();

        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<DownloadProgress>();

        // stderr: collect error output only
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut BufReader::new(stderr_handle), &mut buf).await.ok();
            String::from_utf8_lossy(&buf).to_string()
        });

        // stdout: download progress lines + JSON output
        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout_handle);
            let mut json_buf = String::new();
            let mut line_buf = Vec::new();

            loop {
                let mut byte = [0u8; 1];
                match tokio::io::AsyncReadExt::read(&mut reader, &mut byte).await {
                    Ok(0) => break,
                    Ok(_) => {
                        if byte[0] == b'\r' || byte[0] == b'\n' {
                            if !line_buf.is_empty() {
                                let line = String::from_utf8_lossy(&line_buf).to_string();
                                line_buf.clear();
                                if let Some(p) = Self::parse_stdout_line(&line) {
                                    let _ = progress_tx.send(p);
                                } else if line.starts_with('{') {
                                    json_buf.push_str(&line);
                                    json_buf.push('\n');
                                }
                            }
                        } else {
                            line_buf.push(byte[0]);
                        }
                    }
                    Err(_) => break,
                }
            }
            if !line_buf.is_empty() {
                let line = String::from_utf8_lossy(&line_buf).to_string();
                if let Some(p) = Self::parse_stdout_line(&line) {
                    let _ = progress_tx.send(p);
                } else if line.starts_with('{') {
                    json_buf.push_str(&line);
                    json_buf.push('\n');
                }
            }
            json_buf
        });

        // Receive progress in real-time; channel closes when stdout_task drops the sender
        while let Some(p) = progress_rx.recv().await {
            on_progress(p);
        }

        let stderr_result = stderr_task.await
            .map_err(|e| MediaError::YtDlp(format!("stderr task: {e}")))?;
        let stdout_json = stdout_task.await
            .map_err(|e| MediaError::YtDlp(format!("stdout task: {e}")))?;

        let status = child.wait().await
            .map_err(|e| MediaError::YtDlp(format!("failed to wait for yt-dlp: {e}")))?;

        if !status.success() {
            return Err(MediaError::YtDlp(format!("yt-dlp download failed: {stderr_result}")));
        }

        let last_json = stdout_json
            .lines()
            .rfind(|l| l.starts_with('{'))
            .ok_or_else(|| MediaError::YtDlp("no JSON output".to_string()))?;

        let entry: YtDlpOutput = serde_json::from_str(last_json)
            .map_err(|e| MediaError::YtDlp(format!("parse error: {e}")))?;

        let meta = Self::parse_meta(&entry)
            .ok_or_else(|| MediaError::YtDlp("incomplete metadata".to_string()))?;

        let video_id = entry.id.as_deref().unwrap_or("unknown");
        let file_path = self.find_downloaded_file(video_id)?;

        Ok((file_path, meta))
    }

    fn parse_stdout_line(line: &str) -> Option<DownloadProgress> {
        let line = line.trim();

        // [youtube] ... — resolving metadata
        if line.starts_with("[youtube]") || line.starts_with("[generic]") || line.starts_with("[info]") {
            return Some(DownloadProgress {
                stage: DownloadStage::Resolving,
                percent: 0.0,
                speed_bps: None,
            });
        }

        // [download]  45.3% of ~  3.85MiB at  2.15MiB/s ETA 00:01
        if let Some(content) = line.strip_prefix("[download]") {
            let content = content.trim();
            if let Some(percent_end) = content.find('%')
                && let Ok(percent) = content[..percent_end].trim().parse::<f64>()
            {
                let speed_bps = content.find(" at ").and_then(|idx| {
                    let speed_str = content[idx + 4..].split_whitespace().next()?;
                    Self::parse_speed(speed_str)
                });
                return Some(DownloadProgress {
                    stage: DownloadStage::Downloading,
                    percent,
                    speed_bps,
                });
            }
            // [download] Destination: ... or [download] file has already been downloaded
            return Some(DownloadProgress {
                stage: DownloadStage::Downloading,
                percent: 0.0,
                speed_bps: None,
            });
        }

        // [ExtractAudio] ... — converting
        if line.starts_with("[ExtractAudio]") || line.starts_with("[Merger]") || line.starts_with("[ffmpeg]") {
            return Some(DownloadProgress {
                stage: DownloadStage::Converting,
                percent: 0.0,
                speed_bps: None,
            });
        }

        None
    }

    fn parse_speed(s: &str) -> Option<u64> {
        let s = s.trim();
        if s == "N/A" || s == "Unknown" {
            return None;
        }
        // e.g. "2.15MiB/s", "500.00KiB/s"
        let s = s.trim_end_matches("/s");
        if let Some(num_str) = s.strip_suffix("GiB") {
            let n: f64 = num_str.parse().ok()?;
            Some((n * 1024.0 * 1024.0 * 1024.0) as u64)
        } else if let Some(num_str) = s.strip_suffix("MiB") {
            let n: f64 = num_str.parse().ok()?;
            Some((n * 1024.0 * 1024.0) as u64)
        } else if let Some(num_str) = s.strip_suffix("KiB") {
            let n: f64 = num_str.parse().ok()?;
            Some((n * 1024.0) as u64)
        } else if let Some(num_str) = s.strip_suffix('B') {
            let n: f64 = num_str.parse().ok()?;
            Some(n as u64)
        } else {
            None
        }
    }

    pub async fn get_metadata(&self, url: &str) -> Result<TrackMeta, MediaError> {
        let _permit = SEMAPHORE.acquire().await.map_err(|_| {
            MediaError::YtDlp("semaphore closed".to_string())
        })?;

        let sanitized_url = Self::sanitize_query(url);

        let output = Command::new(self.bin_path())
            .args([
                "--no-exec",
                "--dump-json",
                "--no-download",
                "--no-warnings",
                "--",
                &sanitized_url,
            ])
            .output()
            .await
            .map_err(|e| MediaError::YtDlp(format!("failed to run yt-dlp: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(MediaError::YtDlp(format!("yt-dlp metadata failed: {stderr}")));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let entry: YtDlpOutput = serde_json::from_str(stdout.trim())
            .map_err(|e| MediaError::YtDlp(format!("parse error: {e}")))?;

        Self::parse_meta(&entry).ok_or_else(|| MediaError::YtDlp("incomplete metadata".to_string()))
    }

    fn parse_meta(entry: &YtDlpOutput) -> Option<TrackMeta> {
        let title = entry.title.clone()?;
        let duration_secs = entry.duration.unwrap_or(0.0);

        Some(TrackMeta {
            youtube_id: entry.id.clone(),
            title,
            artist: entry.uploader.clone(),
            duration_ms: (duration_secs * 1000.0) as u64,
            thumbnail_url: entry.thumbnail.clone(),
            source_url: entry
                .webpage_url
                .clone()
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", entry.id.as_deref().unwrap_or(""))),
        })
    }

    fn find_downloaded_file(&self, video_id: &str) -> Result<PathBuf, MediaError> {
        let read_dir = std::fs::read_dir(&self.media_dir)
            .map_err(MediaError::Io)?;

        for entry in read_dir {
            let entry = entry.map_err(MediaError::Io)?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(video_id) {
                let path = entry.path();
                let canonical = path.canonicalize().map_err(MediaError::Io)?;
                let media_canonical = self.media_dir.canonicalize().map_err(MediaError::Io)?;
                if !canonical.starts_with(&media_canonical) {
                    return Err(MediaError::PathTraversal);
                }
                return Ok(canonical);
            }
        }

        Err(MediaError::FileNotFound(format!("downloaded file for {video_id}")))
    }

    pub fn media_dir(&self) -> &Path {
        &self.media_dir
    }

    /// Fetch playlist metadata using --flat-playlist --dump-json.
    /// Each output line is a JSON object for one entry.
    /// Returns (playlist_title, playlist_id, entries).
    pub async fn get_playlist_metadata(
        &self,
        url: &str,
        max_entries: usize,
    ) -> Result<(String, String, Vec<FlatPlaylistEntry>), MediaError> {
        let sanitized_url = Self::sanitize_query(url);

        let output = Command::new(self.bin_path())
            .args([
                "--flat-playlist",
                "--dump-json",
                "--no-warnings",
                "--",
                &sanitized_url,
            ])
            .output()
            .await
            .map_err(|e| MediaError::YtDlp(format!("failed to run yt-dlp: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(MediaError::YtDlp(format!(
                "yt-dlp playlist failed: {stderr}"
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut entries: Vec<FlatPlaylistEntry> = Vec::new();
        let mut playlist_title = String::new();
        let mut playlist_id = String::new();

        for line in stdout.lines() {
            if !line.starts_with('{') {
                continue;
            }
            if entries.len() >= max_entries {
                break;
            }

            let parsed: FlatPlaylistJson = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if playlist_title.is_empty()
                && let Some(ref t) = parsed.playlist_title
            {
                playlist_title = t.clone();
            }
            if playlist_id.is_empty()
                && let Some(ref id) = parsed.playlist_id
            {
                playlist_id = id.clone();
            }

            let id = match parsed.id {
                Some(ref s) => s.clone(),
                None => continue,
            };

            let entry_url = parsed
                .url
                .clone()
                .or_else(|| parsed.webpage_url.clone())
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));

            let title_str = parsed.title.as_deref().unwrap_or("");
            let is_youtube = sanitized_url.contains("youtube.com")
                || sanitized_url.contains("youtu.be");
            let is_unavailable = title_str.contains("[Private video]")
                || title_str.contains("[Deleted video]")
                || (is_youtube && parsed.duration.is_none());

            entries.push(FlatPlaylistEntry {
                id,
                title: parsed.title,
                uploader: parsed.uploader,
                duration: parsed.duration,
                url: entry_url,
                thumbnail: parsed.thumbnail,
                is_unavailable,
            });
        }

        Ok((playlist_title, playlist_id, entries))
    }

    pub async fn download_thumbnail(url: &str, save_path: &Path) -> Result<(), MediaError> {
        if save_path.exists() {
            return Ok(());
        }

        // SSRF defense: allowlist known CDN hosts
        let parsed = url::Url::parse(url)
            .map_err(|e| MediaError::YtDlp(format!("invalid thumbnail URL: {e}")))?;

        match parsed.scheme() {
            "http" | "https" => {}
            scheme => {
                return Err(MediaError::YtDlp(format!(
                    "rejected thumbnail scheme: {scheme}"
                )));
            }
        }

        let host = parsed.host_str().unwrap_or("");
        const ALLOWED_HOSTS: &[&str] = &[
            "i.ytimg.com",
            "i1.ytimg.com",
            "i2.ytimg.com",
            "i3.ytimg.com",
            "i4.ytimg.com",
            "i9.ytimg.com",
            "img.youtube.com",
            "i1.sndcdn.com",
            "i.scdn.co",
        ];
        if !ALLOWED_HOSTS.contains(&host) {
            warn!("thumbnail host not in allowlist: {host}");
            return Ok(());
        }

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(MediaError::Http)?;

        let resp = client.get(url).send().await.map_err(MediaError::Http)?;

        if !resp.status().is_success() {
            warn!("thumbnail download failed: HTTP {}", resp.status());
            return Ok(());
        }

        // Validate content type
        if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
            let ct_str = ct.to_str().unwrap_or("");
            if !ct_str.starts_with("image/") {
                warn!("thumbnail has non-image content type: {ct_str}");
                return Ok(());
            }
        }

        let bytes = resp.bytes().await.map_err(MediaError::Http)?;

        // 5MB limit
        if bytes.len() > 5 * 1024 * 1024 {
            warn!("thumbnail too large: {} bytes", bytes.len());
            return Ok(());
        }

        // Canonical path check
        if let Some(parent) = save_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(MediaError::Io)?;
        }
        tokio::fs::write(save_path, &bytes).await.map_err(MediaError::Io)?;

        // Verify canonical path stays within thumbnails dir
        if let Ok(canonical) = save_path.canonicalize()
            && let Some(parent) = save_path.parent()
            && let Ok(parent_canonical) = parent.canonicalize()
            && !canonical.starts_with(&parent_canonical)
        {
            let _ = tokio::fs::remove_file(save_path).await;
            return Err(MediaError::PathTraversal);
        }

        Ok(())
    }
}
