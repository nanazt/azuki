use super::*;

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

#[test]
fn test_enqueue_and_advance() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    q.enqueue(make_track("3"), test_user());
    assert_eq!(q.len(), 3);

    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "1");
    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "2");
    assert_eq!(q.len(), 1);

    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "3");
    assert!(q.advance().is_none());
}

#[test]
fn test_loop_one() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::One);
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    let e1 = q.advance().unwrap();
    assert_eq!(e1.track.id, "1");
    let e2 = q.advance().unwrap();
    assert_eq!(e2.track.id, "1");
    assert_eq!(q.len(), 2); // Nothing removed
}

#[test]
fn test_loop_all() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::All);
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "1");
    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "2");
    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "1"); // Wraps around
    assert_eq!(q.len(), 2);
}

#[test]
fn test_remove() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    q.enqueue(make_track("3"), test_user());

    let removed = q.remove(1).unwrap();
    assert_eq!(removed.track.id, "2");
    assert_eq!(q.len(), 2);
}

// Q1
#[test]
fn test_enqueue_capacity_limit() {
    let mut q = Queue::new();
    for i in 0..50 {
        assert!(q.enqueue(make_track(&i.to_string()), test_user()));
    }
    assert!(!q.enqueue(make_track("51"), test_user()));
    assert_eq!(q.len(), 50);
}

// Q2
#[test]
fn test_contains() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    q.enqueue(make_track("3"), test_user());
    assert!(q.contains("2"));
    assert!(!q.contains("999"));
}

// Q3
#[test]
fn test_advance_empty() {
    let mut q = Queue::new();
    assert!(q.advance().is_none());
}

// Q4
#[test]
fn test_loop_all_single_item() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::All);
    q.enqueue(make_track("1"), test_user());

    let e1 = q.advance().unwrap();
    assert_eq!(e1.track.id, "1");
    let e2 = q.advance().unwrap();
    assert_eq!(e2.track.id, "1");
    assert_eq!(q.len(), 1);
}

// Q5
#[test]
fn test_loop_one_does_not_consume() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::One);
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    for _ in 0..3 {
        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "1");
    }
    assert_eq!(q.len(), 2);
}

// Q6
#[test]
fn test_clear() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    q.enqueue(make_track("3"), test_user());
    q.clear();
    assert!(q.is_empty());
    assert_eq!(q.len(), 0);
}

// Q7
#[test]
fn test_move_item() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());
    q.enqueue(make_track("C"), test_user());
    assert!(q.move_item(0, 2));
    let ids: Vec<String> = q.items().iter().map(|e| e.track.id.clone()).collect();
    assert_eq!(ids, vec!["B", "C", "A"]);
}

// Q8
#[test]
fn test_move_item_same_position() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());
    q.enqueue(make_track("C"), test_user());
    assert!(q.move_item(1, 1));
    let ids: Vec<String> = q.items().iter().map(|e| e.track.id.clone()).collect();
    assert_eq!(ids, vec!["A", "B", "C"]);
}

// Q9
#[test]
fn test_move_item_out_of_bounds() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());
    q.enqueue(make_track("C"), test_user());
    assert!(!q.move_item(0, 10));
}

// Q9a
#[test]
fn test_move_item_reverse() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());
    q.enqueue(make_track("C"), test_user());
    assert!(q.move_item(2, 0));
    let ids: Vec<String> = q.items().iter().map(|e| e.track.id.clone()).collect();
    assert_eq!(ids, vec!["C", "A", "B"]);
}

// Q10
#[test]
fn test_history_push_and_dedup() {
    let mut q = Queue::new();
    q.push_to_history(make_entry("1"));
    q.push_to_history(make_entry("1"));
    q.push_to_history(make_entry("1"));
    assert_eq!(q.history().len(), 1);
}

// Q11
#[test]
fn test_history_cap_at_50() {
    let mut q = Queue::new();
    for i in 0..51 {
        q.push_to_history(make_entry(&i.to_string()));
    }
    assert_eq!(q.history().len(), 50);
    // Oldest (id "0") should have been removed
    assert_eq!(q.history()[0].track.id, "1");
}

// Q12
#[test]
fn test_go_previous() {
    let mut q = Queue::new();
    q.push_to_history(make_entry("1"));
    q.push_to_history(make_entry("2"));
    q.push_to_history(make_entry("3"));
    assert_eq!(q.history().len(), 3);

    let prev = q.go_previous().unwrap();
    assert_eq!(prev.track.id, "3");
    assert_eq!(q.history().len(), 2);
}

// Q13
#[test]
fn test_go_previous_empty() {
    let mut q = Queue::new();
    assert!(q.go_previous().is_none());
}

// Q14
#[test]
fn test_with_state_constructor() {
    let items = vec![make_entry("A"), make_entry("B")];
    let history = vec![make_entry("X")];
    let q = Queue::with_state(items, history, LoopMode::All);
    assert_eq!(q.len(), 2);
    assert_eq!(q.history().len(), 1);
    assert_eq!(q.loop_mode(), LoopMode::All);
    assert_eq!(q.current().unwrap().track.id, "A");
    assert_eq!(q.history()[0].track.id, "X");
}

// Q15
#[test]
fn test_push_front_and_back() {
    let mut q = Queue::new();
    q.push_front(make_entry("A"));
    q.push_back(make_entry("B"));
    let e = q.advance().unwrap();
    assert_eq!(e.track.id, "A");
}

// Q16
#[test]
fn test_remove_out_of_bounds() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    q.enqueue(make_track("3"), test_user());
    assert!(q.remove(999).is_none());
    assert_eq!(q.len(), 3);
}

// Q17
#[test]
fn test_current() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    assert_eq!(q.current().unwrap().track.id, "1");
    // current() should not consume
    assert_eq!(q.len(), 2);
}

// Q18
#[test]
fn test_current_empty() {
    let q = Queue::new();
    assert!(q.current().is_none());
}

// Q19
#[test]
fn test_set_loop_mode() {
    let mut q = Queue::new();
    assert_eq!(q.loop_mode(), LoopMode::Off);
    q.set_loop_mode(LoopMode::One);
    assert_eq!(q.loop_mode(), LoopMode::One);
    q.set_loop_mode(LoopMode::All);
    assert_eq!(q.loop_mode(), LoopMode::All);
}

// Q20
#[test]
fn test_items_returns_clone() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());
    let snapshot = q.items();
    q.clear();
    assert_eq!(snapshot.len(), 2);
    assert!(q.is_empty());
}

// ───── skip_advance (Q21-Q24) ─────

// Q21: skip_advance in LoopMode::Off pops front (same as advance)
#[test]
fn test_skip_advance_off() {
    let mut q = Queue::new();
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    let e = q.skip_advance().unwrap();
    assert_eq!(e.track.id, "1");
    assert_eq!(q.len(), 1);
}

// Q22: skip_advance in LoopMode::One pops front (unlike advance which clones)
#[test]
fn test_skip_advance_one_pops() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::One);
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    let e = q.skip_advance().unwrap();
    assert_eq!(e.track.id, "1");
    assert_eq!(q.len(), 1); // item was consumed, unlike advance()
    assert_eq!(q.current().unwrap().track.id, "2");
}

// Q23: skip_advance in LoopMode::All rotates (same as advance)
#[test]
fn test_skip_advance_all_rotates() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::All);
    q.enqueue(make_track("1"), test_user());
    q.enqueue(make_track("2"), test_user());

    let e = q.skip_advance().unwrap();
    assert_eq!(e.track.id, "1");
    assert_eq!(q.len(), 2); // rotated, not consumed
}

// Q24: skip_advance on empty queue returns None
#[test]
fn test_skip_advance_empty() {
    let mut q = Queue::new();
    q.set_loop_mode(LoopMode::One);
    assert!(q.skip_advance().is_none());
}

// ───── remove_last_by_track_id (Q25-Q27) ─────

// Q25: removes last occurrence of a track by ID
#[test]
fn test_remove_last_by_track_id() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());
    q.enqueue(make_track("A"), test_user()); // duplicate

    let removed = q.remove_last_by_track_id("A");
    assert!(removed.is_some());
    assert_eq!(removed.unwrap().track.id, "A");
    assert_eq!(q.len(), 2);
    // First A should remain, second A removed
    let ids: Vec<String> = q.items().iter().map(|e| e.track.id.clone()).collect();
    assert_eq!(ids, vec!["A", "B"]);
}

// Q26: returns None when track ID not found
#[test]
fn test_remove_last_by_track_id_not_found() {
    let mut q = Queue::new();
    q.enqueue(make_track("A"), test_user());
    q.enqueue(make_track("B"), test_user());

    assert!(q.remove_last_by_track_id("Z").is_none());
    assert_eq!(q.len(), 2);
}

// Q27: preserves other items when removing
#[test]
fn test_remove_last_by_track_id_preserves_others() {
    let mut q = Queue::new();
    q.enqueue(make_track("X"), test_user());
    q.enqueue(make_track("Y"), test_user());
    q.enqueue(make_track("Z"), test_user());
    q.enqueue(make_track("Y"), test_user()); // duplicate Y

    q.remove_last_by_track_id("Y"); // removes last Y (position 3)
    let ids: Vec<String> = q.items().iter().map(|e| e.track.id.clone()).collect();
    assert_eq!(ids, vec!["X", "Y", "Z"]);
}

// Q28: non-consecutive duplicate is moved to end
#[test]
fn test_history_full_dedup_non_consecutive() {
    let mut q = Queue::new();
    q.push_to_history(make_entry("A"));
    q.push_to_history(make_entry("B"));
    q.push_to_history(make_entry("A"));
    let ids: Vec<&str> = q.history().iter().map(|e| e.track.id.as_str()).collect();
    assert_eq!(ids, vec!["B", "A"]);
}

// Q29: repeated reorderings collapse correctly
#[test]
fn test_history_full_dedup_sequence() {
    let mut q = Queue::new();
    for id in &["A", "B", "C", "A", "B"] {
        q.push_to_history(make_entry(id));
    }
    let ids: Vec<&str> = q.history().iter().map(|e| e.track.id.as_str()).collect();
    assert_eq!(ids, vec!["C", "A", "B"]);
}

// Q30: go_previous after dedup returns correct entry
#[test]
fn test_go_previous_after_full_dedup() {
    let mut q = Queue::new();
    q.push_to_history(make_entry("A"));
    q.push_to_history(make_entry("B"));
    q.push_to_history(make_entry("A"));
    let prev = q.go_previous().unwrap();
    assert_eq!(prev.track.id, "A");
    assert_eq!(q.history().len(), 1);
    assert_eq!(q.history()[0].track.id, "B");
}

// Q31: cap at 50 still works when duplicate re-pushed on full history
#[test]
fn test_history_full_dedup_still_caps_at_50() {
    let mut q = Queue::new();
    for i in 0..50 {
        q.push_to_history(make_entry(&i.to_string()));
    }
    q.push_to_history(make_entry("0")); // re-push oldest
    assert_eq!(q.history().len(), 50);
    assert_eq!(q.history().last().unwrap().track.id, "0");
    assert_eq!(q.history()[0].track.id, "1");
}

// Q32: new track on full history evicts oldest (regression guard)
#[test]
fn test_history_cap_new_track_evicts_oldest() {
    let mut q = Queue::new();
    for i in 0..50 {
        q.push_to_history(make_entry(&i.to_string()));
    }
    q.push_to_history(make_entry("new"));
    assert_eq!(q.history().len(), 50);
    assert_eq!(q.history().last().unwrap().track.id, "new");
    assert_eq!(q.history()[0].track.id, "1");
}

// Q33: single item re-pushed stays length 1
#[test]
fn test_history_full_dedup_single_item_repush() {
    let mut q = Queue::new();
    q.push_to_history(make_entry("Z"));
    q.push_to_history(make_entry("Z"));
    assert_eq!(q.history().len(), 1);
    assert_eq!(q.history()[0].track.id, "Z");
}
