use super::*;
use std::time::Duration;
use tokio::sync::broadcast;

fn make_track(id: &str) -> TrackInfo {
    TrackInfo {
        id: id.to_string(),
        title: format!("Track {id}"),
        artist: None,
        duration_ms: 180_000,
        thumbnail_url: None,
        source_url: format!("https://example.com/{id}"),
        source_type: "youtube".to_string(),
        file_path: None,
        youtube_id: Some(id.to_string()),
        volume: 5,
    }
}

fn test_user() -> UserInfo {
    UserInfo {
        id: "user1".into(),
        username: "User 1".into(),
        avatar_url: None,
    }
}

fn make_entry(id: &str) -> QueueEntry {
    QueueEntry {
        track: make_track(id),
        added_by: test_user(),
    }
}

async fn collect_events(rx: &mut broadcast::Receiver<SeqEvent>, n: usize) -> Vec<SeqEvent> {
    let mut events = Vec::new();
    for i in 0..n {
        let e = tokio::time::timeout(Duration::from_millis(200), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for event {}/{n}", i + 1))
            .expect("broadcast channel closed");
        events.push(e);
    }
    events
}

async fn assert_no_more_events(rx: &mut broadcast::Receiver<SeqEvent>) {
    let result = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await;
    assert!(result.is_err(), "unexpected extra event received");
}

/// Drain all pending events from receiver
async fn drain_events(rx: &mut broadcast::Receiver<SeqEvent>) {
    while let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {}
}

// ───── Basic playback (C1-C7) ─────

// C1
#[tokio::test]
async fn test_play_from_idle() {
    let pc = PlayerController::new();
    let mut rx = pc.subscribe();

    pc.play(make_track("A"), test_user()).await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));

    let events = collect_events(&mut rx, 3).await;
    assert!(matches!(events[0].event, PlayerEvent::TrackLoading { .. }));
    assert!(matches!(events[1].event, PlayerEvent::TrackStarted { .. }));
    assert!(matches!(
        events[2].event,
        PlayerEvent::VolumeChanged { volume: 5 }
    ));
}

// C2
#[tokio::test]
async fn test_pause_while_playing() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.pause().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
}

// C3
#[tokio::test]
async fn test_pause_while_not_playing() {
    let pc = PlayerController::new();
    let result = pc.pause().await;
    assert!(matches!(result, Err(PlayerError::InvalidState(_))));
}

// C4
#[tokio::test]
async fn test_resume_from_paused() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.pause().await.unwrap();
    pc.resume().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));
}

// C5
#[tokio::test]
async fn test_resume_while_not_paused() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let result = pc.resume().await;
    assert!(matches!(result, Err(PlayerError::InvalidState(_))));
}

// C6
#[tokio::test]
async fn test_stop() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.stop().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
}

// C7
#[tokio::test]
async fn test_stop_clears_queue() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    pc.enqueue(make_track("C"), test_user()).await.unwrap();
    pc.stop().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
    assert!(snap.queue.is_empty());
}

// ───── Seek (C8-C10) ─────

// C8
#[tokio::test]
async fn test_seek_while_playing() {
    let pc = PlayerController::new();
    let mut rx = pc.subscribe();
    pc.play(make_track("A"), test_user()).await.unwrap();
    drain_events(&mut rx).await;

    pc.seek(5000).await.unwrap();

    let events = collect_events(&mut rx, 1).await;
    assert!(matches!(
        events[0].event,
        PlayerEvent::Seeked {
            position_ms: 5000,
            paused: false
        }
    ));
    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { .. }));
}

// C9
#[tokio::test]
async fn test_seek_while_paused() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.pause().await.unwrap();
    pc.seek(3000).await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(
        snap.state,
        PlayStateInfo::Paused {
            position_ms: 3000,
            ..
        }
    ));
}

// C10
#[tokio::test]
async fn test_seek_while_idle() {
    let pc = PlayerController::new();
    let result = pc.seek(5000).await;
    assert!(matches!(result, Err(PlayerError::InvalidState(_))));
}

// ───── Volume (C11-C12) ─────

// C11
#[tokio::test]
async fn test_set_volume() {
    let pc = PlayerController::new();
    pc.set_volume(50).await.unwrap();
    let snap = pc.get_state().await;
    assert_eq!(snap.volume, 50);
}

// C12
#[tokio::test]
async fn test_set_volume_clamp_100() {
    let pc = PlayerController::new();
    pc.set_volume(200).await.unwrap();
    let snap = pc.get_state().await;
    assert_eq!(snap.volume, 100);
}

// ───── Loop (C13) ─────

// C13
#[tokio::test]
async fn test_set_loop_mode() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    let snap = pc.get_state().await;
    assert_eq!(snap.loop_mode, LoopMode::One);
}

// ───── Enqueue (C14-C17) ─────

// C14
#[tokio::test]
async fn test_enqueue_while_playing() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();

    let snap = pc.get_state().await;
    assert_eq!(snap.queue.len(), 1);
    assert_eq!(snap.queue[0].track.id, "B");
}

// C15
#[tokio::test]
async fn test_enqueue_duplicate_in_queue() {
    let pc = PlayerController::new();
    pc.play(make_track("X"), test_user()).await.unwrap();
    pc.enqueue(make_track("A"), test_user()).await.unwrap();
    let result = pc.enqueue(make_track("A"), test_user()).await;
    assert!(matches!(result, Err(PlayerError::Duplicate)));
}

// C16
#[tokio::test]
async fn test_enqueue_duplicate_of_current() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let result = pc.enqueue(make_track("A"), test_user()).await;
    assert!(matches!(result, Err(PlayerError::Duplicate)));
}

// C17
#[tokio::test]
async fn test_enqueue_full_queue() {
    let pc = PlayerController::new();
    pc.play(make_track("current"), test_user()).await.unwrap();
    for i in 0..50 {
        pc.enqueue(make_track(&format!("q{i}")), test_user())
            .await
            .unwrap();
    }
    let result = pc.enqueue(make_track("overflow"), test_user()).await;
    assert!(matches!(result, Err(PlayerError::QueueFull)));
}

// ───── PlayOrEnqueue (C18-C21a) ─────

// C18
#[tokio::test]
async fn test_play_or_enqueue_idle() {
    let pc = PlayerController::new();
    let action = pc
        .play_or_enqueue(make_track("A"), test_user())
        .await
        .unwrap();
    assert_eq!(action, PlayAction::PlayedNow);

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));
}

// C19
#[tokio::test]
async fn test_play_or_enqueue_while_playing() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let action = pc
        .play_or_enqueue(make_track("B"), test_user())
        .await
        .unwrap();
    assert_eq!(action, PlayAction::Enqueued);

    let snap = pc.get_state().await;
    assert_eq!(snap.queue.len(), 1);
    assert_eq!(snap.queue[0].track.id, "B");
}

// C20
#[tokio::test]
async fn test_play_or_enqueue_paused_at_end() {
    let pc = PlayerController::with_state(vec![], vec![], LoopMode::Off, Some(make_entry("old")));
    // with_state creates Paused at position 0; seek to >= duration_ms to trigger PlayedNow
    pc.seek(180_000).await.unwrap();

    let action = pc
        .play_or_enqueue(make_track("new"), test_user())
        .await
        .unwrap();
    assert_eq!(action, PlayAction::PlayedNow);

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "new"));
}

// C21
#[tokio::test]
async fn test_play_or_enqueue_duplicate() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let result = pc.play_or_enqueue(make_track("A"), test_user()).await;
    assert!(matches!(result, Err(PlayerError::Duplicate)));
}

// C21a
#[tokio::test]
async fn test_play_or_enqueue_paused_mid_track() {
    let pc =
        PlayerController::with_state(vec![], vec![], LoopMode::Off, Some(make_entry("current")));
    // with_state creates Paused at position 0, which is < duration_ms (180_000)
    let action = pc
        .play_or_enqueue(make_track("new"), test_user())
        .await
        .unwrap();
    assert_eq!(action, PlayAction::Enqueued);

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "current"));
    assert_eq!(snap.queue.len(), 1);
    assert_eq!(snap.queue[0].track.id, "new");
}

// ───── Skip (C22-C25) ─────

// C22
#[tokio::test]
async fn test_skip_to_next() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();

    let skipped = pc.skip().await.unwrap();
    assert_eq!(skipped.unwrap().id, "B");

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
    assert!(snap.history.iter().any(|e| e.track.id == "A"));
}

// C23
#[tokio::test]
async fn test_skip_no_next() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();

    let skipped = pc.skip().await.unwrap();
    assert!(skipped.is_none());

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
}

// C24
#[tokio::test]
async fn test_skip_preserves_paused() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    pc.pause().await.unwrap();

    let skipped = pc.skip().await.unwrap();
    assert_eq!(skipped.unwrap().id, "B");

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "B"));
}

// C25
#[tokio::test]
async fn test_skip_from_idle() {
    let pc = PlayerController::new();
    let skipped = pc.skip().await.unwrap();
    assert!(skipped.is_none());
}

// ───── Previous (C26-C31, C32a-c) ─────

// C26
#[tokio::test]
async fn test_previous_restart_over_threshold() {
    let pc = PlayerController::with_state(vec![], vec![], LoopMode::Off, Some(make_entry("A")));
    // Paused at pos 0, seek to 5000 (> 3000 threshold)
    pc.seek(5000).await.unwrap();
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "A")
    );
}

// C27
#[tokio::test]
async fn test_previous_go_to_history() {
    let pc = PlayerController::new();
    // Play track1, enqueue track2, skip to create history
    pc.play(make_track("track1"), test_user()).await.unwrap();
    pc.enqueue(make_track("track2"), test_user()).await.unwrap();
    pc.skip().await.unwrap(); // now playing track2, track1 in history

    // Pause so position is near 0 (below threshold)
    pc.pause().await.unwrap();

    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    // Should go back to track1 from history
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "track1"));
    // track2 should be pushed to the front of queue
    assert!(snap.queue.iter().any(|e| e.track.id == "track2"));
}

// C28
#[tokio::test]
async fn test_previous_no_history_seek_zero() {
    let pc = PlayerController::with_state(vec![], vec![], LoopMode::Off, Some(make_entry("A")));
    // Paused at pos 0 (below threshold), no history
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "A")
    );
}

// C29: LoopOne + history → goes to previous track (pos < threshold)
#[tokio::test]
async fn test_previous_loop_one_with_history() {
    let pc = PlayerController::with_state(
        vec![],
        vec![make_entry("prev")],
        LoopMode::One,
        Some(make_entry("A")),
    );
    // Paused at pos 0 (below threshold), has history → should go to prev track
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "prev"));
}

// C30
#[tokio::test]
async fn test_previous_from_idle() {
    let pc = PlayerController::new();
    let result = pc.previous().await;
    assert!(matches!(result, Err(PlayerError::InvalidState(_))));
}

// C31
#[tokio::test]
async fn test_previous_preserves_paused() {
    let pc = PlayerController::with_state(vec![], vec![], LoopMode::Off, Some(make_entry("A")));
    pc.seek(5000).await.unwrap();
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    // Should be Paused (was Paused before), position 0
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "A")
    );
}

// C32a: LoopAll + no history + previous → seek to 0
#[tokio::test]
async fn test_previous_loop_all_no_history() {
    // LoopAll, playing X with queue [A, B, C], no history
    let pc = PlayerController::with_state(
        vec![make_entry("A"), make_entry("B"), make_entry("C")],
        vec![],
        LoopMode::All,
        Some(make_entry("X")),
    );
    // Paused at pos 0 (below threshold), no history → seek to 0
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "X")
    );
}

// C32b
#[tokio::test]
async fn test_previous_loop_all_single_item() {
    // LoopAll, playing X with queue [A]
    let pc = PlayerController::with_state(
        vec![make_entry("A")],
        vec![],
        LoopMode::All,
        Some(make_entry("X")),
    );
    // Paused at pos 0 (below threshold)
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    // pop_back gets A (_current_clone), pop_back gets None → seeks to 0
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "X")
    );
}

// C32c: LoopAll + history-based consecutive previous
#[tokio::test]
async fn test_previous_loop_all_consecutive() {
    // LoopAll, queue [A, B] + playing X, history [H1, H2]
    let pc = PlayerController::with_state(
        vec![make_entry("A"), make_entry("B")],
        vec![make_entry("H1"), make_entry("H2")],
        LoopMode::All,
        Some(make_entry("X")),
    );

    pc.previous().await.unwrap();
    let snap1 = pc.get_state().await;
    // Should go to H2 from history
    assert!(matches!(snap1.state, PlayStateInfo::Paused { ref track, .. } if track.id == "H2"));

    pc.previous().await.unwrap();
    let snap2 = pc.get_state().await;
    // Should go to H1 from history
    assert!(matches!(snap2.state, PlayStateInfo::Paused { ref track, .. } if track.id == "H1"));
}

// ───── PlayAt (C32-C34) ─────

// C32 (test_play_at_valid)
#[tokio::test]
async fn test_play_at_valid() {
    let pc = PlayerController::new();
    pc.play(make_track("current"), test_user()).await.unwrap();
    pc.enqueue(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    pc.enqueue(make_track("C"), test_user()).await.unwrap();

    pc.play_at(1).await.unwrap(); // play B

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
    // current should be in history
    assert!(snap.history.iter().any(|e| e.track.id == "current"));
    // queue should be [A, C] (B was removed)
    let queue_ids: Vec<&str> = snap.queue.iter().map(|e| e.track.id.as_str()).collect();
    assert_eq!(queue_ids, vec!["A", "C"]);
}

// C33
#[tokio::test]
async fn test_play_at_invalid() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let result = pc.play_at(99).await;
    assert!(matches!(result, Err(PlayerError::InvalidPosition)));
}

// C34
#[tokio::test]
async fn test_play_at_preserves_paused() {
    let pc = PlayerController::with_state(
        vec![make_entry("A")],
        vec![],
        LoopMode::Off,
        Some(make_entry("current")),
    );

    pc.play_at(0).await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
}

// ───── Remove & Move (C35-C38) ─────

// C35
#[tokio::test]
async fn test_remove_valid() {
    let pc = PlayerController::new();
    pc.play(make_track("X"), test_user()).await.unwrap();
    pc.enqueue(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    pc.enqueue(make_track("C"), test_user()).await.unwrap();

    pc.remove(1).await.unwrap();

    let snap = pc.get_state().await;
    let queue_ids: Vec<&str> = snap.queue.iter().map(|e| e.track.id.as_str()).collect();
    assert_eq!(queue_ids, vec!["A", "C"]);
}

// C36
#[tokio::test]
async fn test_remove_invalid() {
    let pc = PlayerController::new();
    let result = pc.remove(99).await;
    assert!(matches!(result, Err(PlayerError::InvalidPosition)));
}

// C37
#[tokio::test]
async fn test_move_in_queue() {
    let pc = PlayerController::new();
    pc.play(make_track("X"), test_user()).await.unwrap();
    pc.enqueue(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    pc.enqueue(make_track("C"), test_user()).await.unwrap();

    pc.move_in_queue(0, 2).await.unwrap();

    let snap = pc.get_state().await;
    let queue_ids: Vec<&str> = snap.queue.iter().map(|e| e.track.id.as_str()).collect();
    assert_eq!(queue_ids, vec!["B", "C", "A"]);
}

// C38
#[tokio::test]
async fn test_move_invalid() {
    let pc = PlayerController::new();
    pc.play(make_track("X"), test_user()).await.unwrap();
    pc.enqueue(make_track("A"), test_user()).await.unwrap();
    let result = pc.move_in_queue(0, 99).await;
    assert!(matches!(result, Err(PlayerError::InvalidPosition)));
}

// ───── OnTrackEnd (C39-C44b) ─────

// C39
#[tokio::test]
async fn test_on_track_end_advances() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    // Wait for events to propagate
    let events = collect_events(&mut rx, 5).await;
    // TrackEnded, TrackStarted, VolumeChanged, QueueUpdated, HistoryUpdated
    assert!(
        matches!(events[0].event, PlayerEvent::TrackEnded { ref track_id, .. } if track_id == "A")
    );
    assert!(
        matches!(events[1].event, PlayerEvent::TrackStarted { ref track, .. } if track.id == "B")
    );

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
}

// C40
#[tokio::test]
async fn test_on_track_end_to_idle() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    let events = collect_events(&mut rx, 2).await;
    assert!(matches!(events[0].event, PlayerEvent::TrackEnded { .. }));
    assert!(matches!(
        events[1].event,
        PlayerEvent::HistoryUpdated { .. }
    ));

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
}

// C41
#[tokio::test]
async fn test_on_track_end_loop_one_replays() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    let events = collect_events(&mut rx, 3).await;
    // TrackEnded, TrackStarted(same track), VolumeChanged — no HistoryUpdated
    assert!(
        matches!(events[0].event, PlayerEvent::TrackEnded { ref track_id, .. } if track_id == "A")
    );
    assert!(
        matches!(events[1].event, PlayerEvent::TrackStarted { ref track, .. } if track.id == "A")
    );

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));
}

// C42
#[tokio::test]
async fn test_on_track_end_wrong_track_id() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("B".to_string(), TrackEndReason::Finished)
        .await;

    // Give actor time to process the command, then verify no events
    assert_no_more_events(&mut rx).await;

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));
}

// C43
#[tokio::test]
async fn test_on_track_end_error_broadcasts() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end(
        "A".to_string(),
        TrackEndReason::Error("decode failed".into()),
    )
    .await;

    let events = collect_events(&mut rx, 3).await;
    // TrackError, TrackEnded, HistoryUpdated
    assert!(
        matches!(events[0].event, PlayerEvent::TrackError { ref error, .. } if error == "decode failed")
    );
}

// C44
#[tokio::test]
async fn test_on_track_end_history() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    // Give actor time to process
    tokio::time::sleep(Duration::from_millis(50)).await;
    let snap = pc.get_state().await;
    assert!(snap.history.iter().any(|e| e.track.id == "A"));
}

// C44a
#[tokio::test]
async fn test_on_track_end_loop_all_preserves_queue() {
    let pc = PlayerController::with_state(
        vec![make_entry("B"), make_entry("C")],
        vec![],
        LoopMode::All,
        None,
    );
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    // Wait for events: TrackEnded, TrackStarted, VolumeChanged, QueueUpdated, HistoryUpdated
    let events = collect_events(&mut rx, 5).await;
    assert!(
        matches!(events[1].event, PlayerEvent::TrackStarted { ref track, .. } if track.id == "B")
    );

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
    // LoopAll: B was popped from front and pushed to back, so queue = [C, B]
    assert_eq!(snap.queue.len(), 2);
}

// C44b
#[tokio::test]
async fn test_on_track_end_while_paused_ignored() {
    let pc = PlayerController::with_state(
        vec![make_entry("B")],
        vec![],
        LoopMode::Off,
        Some(make_entry("A")),
    );
    // State is Paused (from with_state)
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    // Paused doesn't match OnTrackEnd's Playing|Loading|Error check, so ignored
    assert_no_more_events(&mut rx).await;

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
}

// ───── Snapshot & State (C45-C47) ─────

// C45
#[tokio::test]
async fn test_get_state_idle() {
    let pc = PlayerController::new();
    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
    assert!(snap.queue.is_empty());
    assert_eq!(snap.volume, 5);
}

// C46
#[tokio::test]
async fn test_with_state_restores() {
    let queue = vec![make_entry("A"), make_entry("B")];
    let history = vec![make_entry("X")];
    let current = make_entry("cur");
    let pc = PlayerController::with_state(queue, history, LoopMode::All, Some(current));

    let snap = pc.get_state().await;
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "cur")
    );
    assert_eq!(snap.queue.len(), 2);
    assert_eq!(snap.queue[0].track.id, "A");
    assert_eq!(snap.queue[1].track.id, "B");
    assert_eq!(snap.history.len(), 1);
    assert_eq!(snap.history[0].track.id, "X");
    assert_eq!(snap.loop_mode, LoopMode::All);
}

// C47
#[tokio::test]
async fn test_subscribe_receives_events() {
    let pc = PlayerController::new();
    let mut rx = pc.subscribe();

    pc.play(make_track("A"), test_user()).await.unwrap();

    let events = collect_events(&mut rx, 3).await;
    assert!(!events.is_empty());
    assert!(matches!(events[0].event, PlayerEvent::TrackLoading { .. }));
}

// ───── Event sequence (C48-C49) ─────

// C48
#[tokio::test]
async fn test_seq_monotonically_increases() {
    let pc = PlayerController::new();
    let mut rx = pc.subscribe();

    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.pause().await.unwrap();
    pc.resume().await.unwrap();

    // play emits 3 events, pause 1, resume 1 = 5 total
    let events = collect_events(&mut rx, 5).await;
    for window in events.windows(2) {
        assert!(
            window[1].seq > window[0].seq,
            "seq should strictly increase: {} > {}",
            window[1].seq,
            window[0].seq
        );
    }
}

// C49
#[tokio::test]
async fn test_play_event_sequence() {
    let pc = PlayerController::new();
    let mut rx = pc.subscribe();

    pc.play(make_track("A"), test_user()).await.unwrap();

    let events = collect_events(&mut rx, 3).await;
    assert!(matches!(events[0].event, PlayerEvent::TrackLoading { .. }));
    assert!(matches!(events[1].event, PlayerEvent::TrackStarted { .. }));
    assert!(matches!(events[2].event, PlayerEvent::VolumeChanged { .. }));
    assert_no_more_events(&mut rx).await;
}

// ───── LoopMode bug fixes (C50-C55) ─────

// C50: LoopMode::One OnTrackEnd should NOT add to history
#[tokio::test]
async fn test_loop_one_track_end_no_history_push() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    pc.play(make_track("A"), test_user()).await.unwrap();

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    tokio::time::sleep(Duration::from_millis(50)).await;
    let snap = pc.get_state().await;
    assert!(
        snap.history.is_empty(),
        "LoopMode::One should not push to history"
    );
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "A"));
}

// C51: LoopMode::Off OnTrackEnd adds to history (unchanged behavior)
#[tokio::test]
async fn test_loop_off_track_end_adds_history() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    tokio::time::sleep(Duration::from_millis(50)).await;
    let snap = pc.get_state().await;
    assert!(snap.history.iter().any(|e| e.track.id == "A"));
}

// C52: LoopMode::All OnTrackEnd adds to history (unchanged behavior)
#[tokio::test]
async fn test_loop_all_track_end_adds_history() {
    let pc = PlayerController::with_state(vec![make_entry("B")], vec![], LoopMode::All, None);
    pc.play(make_track("A"), test_user()).await.unwrap();

    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;

    tokio::time::sleep(Duration::from_millis(50)).await;
    let snap = pc.get_state().await;
    assert!(snap.history.iter().any(|e| e.track.id == "A"));
}

// C53: LoopMode::One Skip should advance to next track, not replay
#[tokio::test]
async fn test_loop_one_skip_advances_to_next() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();

    let skipped = pc.skip().await.unwrap();
    assert_eq!(skipped.unwrap().id, "B");

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
    assert!(snap.history.iter().any(|e| e.track.id == "A"));
}

// C54: LoopMode::One Skip with empty queue goes to Idle
#[tokio::test]
async fn test_loop_one_skip_empty_queue_goes_idle() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    pc.play(make_track("A"), test_user()).await.unwrap();

    let skipped = pc.skip().await.unwrap();
    assert!(skipped.is_none());

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Idle));
}

// C55: Skip to empty queue sends HistoryUpdated
#[tokio::test]
async fn test_skip_empty_queue_sends_history_updated() {
    let pc = PlayerController::new();
    pc.play(make_track("A"), test_user()).await.unwrap();
    let mut rx = pc.subscribe();
    drain_events(&mut rx).await;

    pc.skip().await.unwrap();

    let events = collect_events(&mut rx, 2).await;
    assert!(matches!(events[0].event, PlayerEvent::TrackEnded { .. }));
    assert!(matches!(
        events[1].event,
        PlayerEvent::HistoryUpdated { .. }
    ));
}

// ───── Previous with LoopMode fixes (C56-C60) ─────

// C56: LoopOne + skip + previous (pos < 3s) goes to previous track from history
#[tokio::test]
async fn test_previous_loop_one_skip_then_previous() {
    let pc = PlayerController::new();
    pc.set_loop(LoopMode::One).await.unwrap();
    pc.play(make_track("A"), test_user()).await.unwrap();
    pc.enqueue(make_track("B"), test_user()).await.unwrap();

    // Skip: A goes to history, now playing B
    pc.skip().await.unwrap();
    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));

    // Pause to keep position near 0 (below threshold)
    pc.pause().await.unwrap();

    // Previous: should go back to A from history
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
    // B should be in queue
    assert!(snap.queue.iter().any(|e| e.track.id == "B"));
}

// C57: LoopAll + natural playback + previous (pos < 3s) goes to previous track from history
#[tokio::test]
async fn test_previous_loop_all_natural_then_previous() {
    let pc = PlayerController::with_state(
        vec![make_entry("B"), make_entry("C")],
        vec![],
        LoopMode::All,
        None,
    );
    pc.play(make_track("A"), test_user()).await.unwrap();

    // Natural end: A goes to history, B starts, queue rotates
    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Playing { ref track, .. } if track.id == "B"));
    assert!(snap.history.iter().any(|e| e.track.id == "A"));

    // Pause to keep position near 0
    pc.pause().await.unwrap();

    // Previous: should go back to A from history
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
}

// C58: LoopAll + enqueue then previous preserves enqueued track
#[tokio::test]
async fn test_previous_loop_all_enqueue_preserved() {
    let pc = PlayerController::with_state(
        vec![make_entry("B")],
        vec![make_entry("prev")],
        LoopMode::All,
        Some(make_entry("A")),
    );

    // Enqueue a new track
    pc.enqueue(make_track("NEW"), test_user()).await.unwrap();

    let snap_before = pc.get_state().await;
    assert!(snap_before.queue.iter().any(|e| e.track.id == "NEW"));

    // Previous (pos=0, below threshold)
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "prev"));
    // NEW should still be in the queue
    assert!(
        snap.queue.iter().any(|e| e.track.id == "NEW"),
        "enqueued track NEW should be preserved after previous"
    );
}

// C59: LoopAll + previous maintains rotation invariant
// Previous brings a track from history into the rotation, so queue grows by 1
// (current pushed to front + prev clone pushed to back, current's old clone removed)
#[tokio::test]
async fn test_previous_loop_all_rotation_invariant() {
    let pc = PlayerController::with_state(
        vec![make_entry("B"), make_entry("C")],
        vec![],
        LoopMode::All,
        None,
    );
    pc.play(make_track("A"), test_user()).await.unwrap();

    // Natural end: A → history, now playing B, queue = [C, B] (len 2)
    pc.on_track_end("A".to_string(), TrackEndReason::Finished)
        .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Pause + previous: A comes back from history into the rotation
    pc.pause().await.unwrap();
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    // Now playing A, queue = [B, C, A-clone] (len 3)
    assert!(matches!(snap.state, PlayStateInfo::Paused { ref track, .. } if track.id == "A"));
    assert_eq!(snap.queue.len(), 3, "prev track added to rotation");
    // A's clone should be at the back (rotation invariant)
    assert_eq!(snap.queue.last().unwrap().track.id, "A");
}

// C60: LoopOne + no history + previous (pos < 3s) seeks to 0
#[tokio::test]
async fn test_previous_loop_one_no_history_seeks_zero() {
    let pc = PlayerController::with_state(vec![], vec![], LoopMode::One, Some(make_entry("A")));
    // Paused at pos 0, no history → should seek to 0
    pc.previous().await.unwrap();

    let snap = pc.get_state().await;
    assert!(
        matches!(snap.state, PlayStateInfo::Paused { ref track, position_ms: 0 } if track.id == "A")
    );
}
