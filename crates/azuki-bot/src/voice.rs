use std::sync::Arc;

use serenity::all::GuildId;
use songbird::input::File as AudioFile;
use songbird::Songbird;
use tracing::{error, info};

pub async fn join_channel(
    songbird: &Arc<Songbird>,
    guild_id: GuildId,
    channel_id: serenity::all::ChannelId,
) -> Result<(), String> {
    let result = songbird.join(guild_id, channel_id).await;
    match result {
        Ok(_handle) => {
            info!("joined voice channel {channel_id}");
            Ok(())
        }
        Err(e) => Err(format!("failed to join: {e}")),
    }
}

pub async fn leave_channel(songbird: &Arc<Songbird>, guild_id: GuildId) {
    if let Err(e) = songbird.leave(guild_id).await {
        error!("failed to leave voice: {e}");
    }
}

pub async fn play_file(songbird: &Arc<Songbird>, guild_id: GuildId, file_path: &str) -> Option<songbird::tracks::TrackHandle> {
    if let Some(call) = songbird.get(guild_id) {
        let mut handler = call.lock().await;
        handler.stop();
        let source = AudioFile::new(file_path.to_string());
        let track_handle = handler.play_input(source.into());
        info!("playing audio: {file_path}");
        Some(track_handle)
    } else {
        None
    }
}

pub fn set_volume(track_handle: &songbird::tracks::TrackHandle, volume: u8) {
    let _ = track_handle.set_volume(volume as f32 / 100.0);
}
