use std::collections::HashMap;
use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::events::{LoopMode, QueueEntry};
use crate::queue::Queue;

pub type SlotId = u8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum QueueKind {
    Default,
    Playlist { playlist_id: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueSlotInfo {
    pub slot_id: SlotId,
    pub kind: QueueKind,
    pub track_count: usize,
    pub current_track: Option<QueueEntry>,
    pub loop_mode: LoopMode,
    pub paused_track_id: Option<String>,
}

pub struct PlaylistOverflow {
    pub playlist_id: i64,
    pub remaining: VecDeque<QueueEntry>,
    pub total_tracks: usize,
    pub loaded_count: usize,
}

pub struct QueueSlotState {
    pub queue: Queue,
    pub kind: QueueKind,
    pub paused_track_id: Option<String>,
    pub overflow: Option<PlaylistOverflow>,
}

pub struct MultiQueue {
    default_queue: Queue,
    playlist_slots: HashMap<SlotId, QueueSlotState>,
    active_slot: SlotId,
}

impl MultiQueue {
    pub fn new() -> Self {
        Self {
            default_queue: Queue::new(),
            playlist_slots: HashMap::new(),
            active_slot: 0,
        }
    }

    pub fn with_default_queue(queue: Queue) -> Self {
        Self {
            default_queue: queue,
            playlist_slots: HashMap::new(),
            active_slot: 0,
        }
    }

    pub fn active_slot(&self) -> SlotId {
        self.active_slot
    }

    pub fn active_queue(&self) -> &Queue {
        if self.active_slot == 0 {
            &self.default_queue
        } else {
            self.playlist_slots
                .get(&self.active_slot)
                .map(|s| &s.queue)
                .unwrap_or(&self.default_queue)
        }
    }

    pub fn active_queue_mut(&mut self) -> &mut Queue {
        if self.active_slot == 0 {
            &mut self.default_queue
        } else if self.playlist_slots.contains_key(&self.active_slot) {
            &mut self.playlist_slots.get_mut(&self.active_slot).unwrap().queue
        } else {
            self.active_slot = 0;
            &mut self.default_queue
        }
    }

    pub fn active_kind(&self) -> QueueKind {
        if self.active_slot == 0 {
            QueueKind::Default
        } else {
            self.playlist_slots
                .get(&self.active_slot)
                .map(|s| s.kind)
                .unwrap_or(QueueKind::Default)
        }
    }

    pub fn get_slot(&self, slot: SlotId) -> Option<&QueueSlotState> {
        if slot == 0 {
            return None;
        }
        self.playlist_slots.get(&slot)
    }

    /// Create a playlist slot in the next free slot (1-4). Returns None if full.
    pub fn create_playlist_slot(
        &mut self,
        playlist_id: i64,
        entries: Vec<QueueEntry>,
        overflow: Option<PlaylistOverflow>,
    ) -> Option<SlotId> {
        let slot_id = (1..=4u8).find(|id| !self.playlist_slots.contains_key(id))?;

        let mut queue = Queue::new();
        for entry in entries {
            queue.enqueue(entry.track, entry.added_by);
        }

        self.playlist_slots.insert(
            slot_id,
            QueueSlotState {
                queue,
                kind: QueueKind::Playlist { playlist_id },
                paused_track_id: None,
                overflow,
            },
        );

        Some(slot_id)
    }

    /// Delete a playlist slot. Refuses slot 0.
    pub fn delete_slot(&mut self, slot: SlotId) -> bool {
        if slot == 0 {
            return false;
        }
        self.playlist_slots.remove(&slot).is_some()
    }

    /// Switch to a different queue slot. Saves current track id as paused_track for current slot.
    pub fn switch_to(
        &mut self,
        slot: SlotId,
        current_track_id: Option<String>,
    ) -> Result<(), crate::controller::PlayerError> {
        if slot == self.active_slot {
            return Ok(());
        }
        if slot != 0 && !self.playlist_slots.contains_key(&slot) {
            return Err(crate::controller::PlayerError::InvalidState(format!(
                "slot {slot} does not exist"
            )));
        }

        // Save paused track for current slot
        if self.active_slot != 0
            && let Some(state) = self.playlist_slots.get_mut(&self.active_slot)
        {
            state.paused_track_id = current_track_id;
        }

        self.active_slot = slot;

        // Reset loop mode for new playlist slot
        if slot != 0
            && let Some(state) = self.playlist_slots.get_mut(&slot)
        {
            state.queue.set_loop_mode(LoopMode::Off);
        }

        Ok(())
    }

    /// Refill active queue from overflow if queue length < 20, up to 30 items.
    /// Returns the refilled entries (for pre-download).
    pub fn refill_from_overflow(&mut self) -> Vec<QueueEntry> {
        if self.active_slot == 0 {
            return Vec::new();
        }

        let state = match self.playlist_slots.get_mut(&self.active_slot) {
            Some(s) => s,
            None => return Vec::new(),
        };

        let overflow = match &mut state.overflow {
            Some(o) => o,
            None => return Vec::new(),
        };

        if state.queue.len() >= 20 {
            return Vec::new();
        }

        let count = 30.min(overflow.remaining.len());
        let mut refilled = Vec::with_capacity(count);

        for _ in 0..count {
            if let Some(entry) = overflow.remaining.pop_front() {
                refilled.push(entry.clone());
                state.queue.enqueue(entry.track, entry.added_by);
            }
        }

        overflow.loaded_count += refilled.len();

        refilled
    }

    /// Check if active slot is exhausted (queue empty + overflow empty).
    pub fn is_active_exhausted(&self) -> bool {
        if self.active_slot == 0 {
            return false;
        }

        let state = match self.playlist_slots.get(&self.active_slot) {
            Some(s) => s,
            None => return true,
        };

        state.queue.is_empty()
            && state
                .overflow
                .as_ref()
                .is_none_or(|o| o.remaining.is_empty())
    }

    /// Get lightweight snapshot of all slots.
    pub fn snapshot_slots(&self) -> Vec<QueueSlotInfo> {
        let mut slots = Vec::new();

        slots.push(QueueSlotInfo {
            slot_id: 0,
            kind: QueueKind::Default,
            track_count: self.default_queue.len(),
            current_track: self.default_queue.current().cloned(),
            loop_mode: self.default_queue.loop_mode(),
            paused_track_id: None,
        });

        for slot_id in 1..=4u8 {
            if let Some(state) = self.playlist_slots.get(&slot_id) {
                let overflow_remaining =
                    state.overflow.as_ref().map_or(0, |o| o.remaining.len());
                slots.push(QueueSlotInfo {
                    slot_id,
                    kind: state.kind,
                    track_count: state.queue.len() + overflow_remaining,
                    current_track: state.queue.current().cloned(),
                    loop_mode: state.queue.loop_mode(),
                    paused_track_id: state.paused_track_id.clone(),
                });
            }
        }

        slots
    }

    pub fn default_queue(&self) -> &Queue {
        &self.default_queue
    }

    pub fn default_queue_mut(&mut self) -> &mut Queue {
        &mut self.default_queue
    }
}

impl Default for MultiQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{TrackInfo, UserInfo};

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
    fn test_new_starts_at_slot_0() {
        let mq = MultiQueue::new();
        assert_eq!(mq.active_slot(), 0);
        assert_eq!(mq.active_kind(), QueueKind::Default);
    }

    #[test]
    fn test_create_playlist_slot() {
        let mut mq = MultiQueue::new();
        let entries = vec![make_entry("1"), make_entry("2")];
        let slot = mq.create_playlist_slot(42, entries, None);
        assert_eq!(slot, Some(1));
        assert!(mq.get_slot(1).is_some());
    }

    #[test]
    fn test_create_fills_slots_1_to_4() {
        let mut mq = MultiQueue::new();
        for i in 1..=4 {
            let slot = mq.create_playlist_slot(i as i64, vec![], None);
            assert_eq!(slot, Some(i));
        }
        // 5th should fail
        let slot = mq.create_playlist_slot(99, vec![], None);
        assert_eq!(slot, None);
    }

    #[test]
    fn test_delete_slot() {
        let mut mq = MultiQueue::new();
        mq.create_playlist_slot(1, vec![make_entry("a")], None);
        assert!(mq.delete_slot(1));
        assert!(mq.get_slot(1).is_none());
        // Can't delete slot 0
        assert!(!mq.delete_slot(0));
    }

    #[test]
    fn test_switch_to() {
        let mut mq = MultiQueue::new();
        mq.create_playlist_slot(10, vec![make_entry("a")], None);
        mq.switch_to(1, Some("current_track".into())).unwrap();
        assert_eq!(mq.active_slot(), 1);
        assert!(matches!(mq.active_kind(), QueueKind::Playlist { playlist_id: 10 }));
    }

    #[test]
    fn test_switch_to_nonexistent_errors() {
        let mut mq = MultiQueue::new();
        let result = mq.switch_to(3, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_refill_from_overflow() {
        let mut mq = MultiQueue::new();
        // Create a playlist slot with overflow
        let overflow_entries: VecDeque<QueueEntry> = (10..40).map(|i| make_entry(&i.to_string())).collect();
        let overflow = PlaylistOverflow {
            playlist_id: 1,
            remaining: overflow_entries,
            total_tracks: 30,
            loaded_count: 0,
        };
        mq.create_playlist_slot(1, vec![], Some(overflow));
        mq.switch_to(1, None).unwrap();

        // Queue is empty (< 20), so refill should pull up to 30
        let refilled = mq.refill_from_overflow();
        assert_eq!(refilled.len(), 30);
        assert_eq!(mq.active_queue().len(), 30);
    }

    #[test]
    fn test_refill_no_op_when_queue_full() {
        let mut mq = MultiQueue::new();
        // Fill queue with 20 items
        let initial: Vec<QueueEntry> = (0..20).map(|i| make_entry(&i.to_string())).collect();
        let overflow_entries: VecDeque<QueueEntry> =
            (20..30).map(|i| make_entry(&i.to_string())).collect();
        let overflow = PlaylistOverflow {
            playlist_id: 1,
            remaining: overflow_entries,
            total_tracks: 30,
            loaded_count: 20,
        };
        mq.create_playlist_slot(1, initial, Some(overflow));
        mq.switch_to(1, None).unwrap();

        let refilled = mq.refill_from_overflow();
        assert_eq!(refilled.len(), 0);
    }

    #[test]
    fn test_is_active_exhausted() {
        let mut mq = MultiQueue::new();
        // Default queue never exhausts
        assert!(!mq.is_active_exhausted());

        // Empty playlist slot with no overflow is exhausted
        mq.create_playlist_slot(1, vec![], None);
        mq.switch_to(1, None).unwrap();
        assert!(mq.is_active_exhausted());
    }

    #[test]
    fn test_snapshot_slots() {
        let mut mq = MultiQueue::new();
        mq.default_queue_mut().enqueue(make_track("d1"), test_user());
        mq.create_playlist_slot(5, vec![make_entry("p1"), make_entry("p2")], None);

        let slots = mq.snapshot_slots();
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].slot_id, 0);
        assert_eq!(slots[0].track_count, 1);
        assert_eq!(slots[1].slot_id, 1);
        assert_eq!(slots[1].track_count, 2);
    }

    #[test]
    fn test_active_queue_mut_fallback_on_missing_slot() {
        let mut mq = MultiQueue::new();
        // Force active_slot to a non-existent slot
        mq.create_playlist_slot(1, vec![], None);
        mq.switch_to(1, None).unwrap();
        mq.delete_slot(1);
        // active_slot is still 1 but slot doesn't exist
        // active_queue_mut should fall back to default
        let _q = mq.active_queue_mut();
        assert_eq!(mq.active_slot(), 0);
    }
}
