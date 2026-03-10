use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectedUrl {
    YoutubeVideo { video_id: String },
    YoutubePlaylist { playlist_id: String },
    SoundcloudTrack { url: String },
    SoundcloudPlaylist { url: String },
    Other { url: String },
}

pub fn detect_url(input: &str) -> DetectedUrl {
    let parsed = match Url::parse(input) {
        Ok(u) => u,
        Err(_) => {
            return DetectedUrl::Other {
                url: input.to_string(),
            };
        }
    };

    match parsed.host_str() {
        Some("www.youtube.com" | "youtube.com" | "m.youtube.com" | "music.youtube.com") => {
            let list = parsed
                .query_pairs()
                .find(|(k, _)| k == "list")
                .map(|(_, v)| v.to_string());
            let video = parsed
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.to_string());

            if let Some(playlist_id) = list {
                DetectedUrl::YoutubePlaylist { playlist_id }
            } else if let Some(video_id) = video {
                DetectedUrl::YoutubeVideo { video_id }
            } else {
                DetectedUrl::Other {
                    url: input.to_string(),
                }
            }
        }
        Some("youtu.be") => {
            let path = parsed.path().trim_start_matches('/');
            if path.is_empty() {
                DetectedUrl::Other {
                    url: input.to_string(),
                }
            } else {
                let video_id = path.split('/').next().unwrap_or("").to_string();
                if video_id.is_empty() {
                    DetectedUrl::Other {
                        url: input.to_string(),
                    }
                } else {
                    DetectedUrl::YoutubeVideo { video_id }
                }
            }
        }
        Some("soundcloud.com" | "www.soundcloud.com" | "m.soundcloud.com") => {
            let path = parsed.path();
            let segments: Vec<&str> = path
                .trim_start_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
                .collect();

            let canonical = format!("https://soundcloud.com/{}", segments.join("/"));

            match segments.as_slice() {
                [_user, "sets", _slug] => DetectedUrl::SoundcloudPlaylist { url: canonical },
                [_user, track] if *track != "sets" => {
                    DetectedUrl::SoundcloudTrack { url: canonical }
                }
                _ => DetectedUrl::Other {
                    url: input.to_string(),
                },
            }
        }
        _ => DetectedUrl::Other {
            url: input.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_video_watch() {
        let result = detect_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(
            result,
            DetectedUrl::YoutubeVideo {
                video_id: "dQw4w9WgXcQ".to_string()
            }
        );
    }

    #[test]
    fn youtube_video_watch_no_www() {
        let result = detect_url("https://youtube.com/watch?v=abc123");
        assert_eq!(
            result,
            DetectedUrl::YoutubeVideo {
                video_id: "abc123".to_string()
            }
        );
    }

    #[test]
    fn youtube_video_mobile() {
        let result = detect_url("https://m.youtube.com/watch?v=xyz789");
        assert_eq!(
            result,
            DetectedUrl::YoutubeVideo {
                video_id: "xyz789".to_string()
            }
        );
    }

    #[test]
    fn youtube_video_music() {
        let result = detect_url("https://music.youtube.com/watch?v=abc111");
        assert_eq!(
            result,
            DetectedUrl::YoutubeVideo {
                video_id: "abc111".to_string()
            }
        );
    }

    #[test]
    fn youtu_be_short_url() {
        let result = detect_url("https://youtu.be/dQw4w9WgXcQ");
        assert_eq!(
            result,
            DetectedUrl::YoutubeVideo {
                video_id: "dQw4w9WgXcQ".to_string()
            }
        );
    }

    #[test]
    fn youtube_playlist_explicit() {
        let result =
            detect_url("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI");
        assert_eq!(
            result,
            DetectedUrl::YoutubePlaylist {
                playlist_id: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI".to_string()
            }
        );
    }

    #[test]
    fn youtube_playlist_with_video() {
        let result = detect_url(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
        );
        // list param takes priority
        assert_eq!(
            result,
            DetectedUrl::YoutubePlaylist {
                playlist_id: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI".to_string()
            }
        );
    }

    #[test]
    fn soundcloud_track() {
        let result = detect_url("https://soundcloud.com/artistname/trackname");
        assert_eq!(
            result,
            DetectedUrl::SoundcloudTrack {
                url: "https://soundcloud.com/artistname/trackname".to_string()
            }
        );
    }

    #[test]
    fn soundcloud_track_www() {
        let result = detect_url("https://www.soundcloud.com/artistname/my-track");
        assert_eq!(
            result,
            DetectedUrl::SoundcloudTrack {
                url: "https://soundcloud.com/artistname/my-track".to_string()
            }
        );
    }

    #[test]
    fn soundcloud_playlist() {
        let result = detect_url("https://soundcloud.com/artistname/sets/my-playlist");
        assert_eq!(
            result,
            DetectedUrl::SoundcloudPlaylist {
                url: "https://soundcloud.com/artistname/sets/my-playlist".to_string()
            }
        );
    }

    #[test]
    fn soundcloud_mobile_playlist() {
        let result = detect_url("https://m.soundcloud.com/user123/sets/cool-set");
        assert_eq!(
            result,
            DetectedUrl::SoundcloudPlaylist {
                url: "https://soundcloud.com/user123/sets/cool-set".to_string()
            }
        );
    }

    #[test]
    fn other_url() {
        let result = detect_url("https://example.com/some/path");
        assert!(matches!(result, DetectedUrl::Other { .. }));
    }

    #[test]
    fn invalid_url() {
        let result = detect_url("not a url at all");
        assert!(matches!(result, DetectedUrl::Other { .. }));
    }

    #[test]
    fn soundcloud_user_only_no_match() {
        // Only one segment — neither track nor playlist
        let result = detect_url("https://soundcloud.com/artistname");
        assert!(matches!(result, DetectedUrl::Other { .. }));
    }
}
