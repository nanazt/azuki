use std::collections::VecDeque;

use crate::events::{LoopMode, QueueEntry, TrackInfo, UserInfo};

#[derive(Debug, Default)]
pub struct Queue {
    items: VecDeque<QueueEntry>,
    loop_mode: LoopMode,
    history: Vec<QueueEntry>,
}

impl Queue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_history(history: Vec<QueueEntry>) -> Self {
        Self {
            items: VecDeque::new(),
            loop_mode: LoopMode::Off,
            history,
        }
    }

    pub fn with_state(
        items: Vec<QueueEntry>,
        history: Vec<QueueEntry>,
        loop_mode: LoopMode,
    ) -> Self {
        Self {
            items: VecDeque::from(items),
            loop_mode,
            history,
        }
    }

    pub fn contains(&self, track_id: &str) -> bool {
        self.items.iter().any(|e| e.track.id == track_id)
    }

    pub fn enqueue(&mut self, track: TrackInfo, added_by: UserInfo) -> bool {
        if self.items.len() >= 50 {
            return false;
        }
        self.items.push_back(QueueEntry { track, added_by });
        true
    }

    pub fn advance(&mut self) -> Option<QueueEntry> {
        match self.loop_mode {
            LoopMode::Off => self.items.pop_front(),
            LoopMode::One => self.items.front().cloned(),
            LoopMode::All => {
                let entry = self.items.pop_front();
                if let Some(ref e) = entry {
                    self.items.push_back(e.clone());
                }
                entry
            }
        }
    }

    /// Like `advance()`, but always moves to the next track (ignoring LoopMode::One).
    /// Used by Skip to ensure the user actually advances past the current track.
    pub fn skip_advance(&mut self) -> Option<QueueEntry> {
        match self.loop_mode {
            LoopMode::Off | LoopMode::One => self.items.pop_front(),
            LoopMode::All => {
                let entry = self.items.pop_front();
                if let Some(ref e) = entry {
                    self.items.push_back(e.clone());
                }
                entry
            }
        }
    }

    pub fn push_to_history(&mut self, entry: QueueEntry) {
        self.push_history(entry);
    }

    pub fn go_previous(&mut self) -> Option<QueueEntry> {
        self.history.pop()
    }

    pub fn push_front(&mut self, entry: QueueEntry) {
        self.items.push_front(entry);
    }

    pub fn push_back(&mut self, entry: QueueEntry) {
        self.items.push_back(entry);
    }

    pub fn pop_back(&mut self) -> Option<QueueEntry> {
        self.items.pop_back()
    }

    /// Remove the last occurrence of a track by ID from the queue.
    /// Used to clean up rotation clones in LoopMode::All before/after go_previous.
    pub fn remove_last_by_track_id(&mut self, id: &str) -> Option<QueueEntry> {
        if let Some(pos) = self.items.iter().rposition(|e| e.track.id == id) {
            self.items.remove(pos)
        } else {
            None
        }
    }

    pub fn history(&self) -> &[QueueEntry] {
        &self.history
    }

    fn push_history(&mut self, entry: QueueEntry) {
        // Deduplicate consecutive entries
        if let Some(last) = self.history.last()
            && last.track.id == entry.track.id
        {
            return;
        }
        self.history.push(entry);
        // Cap history at 50
        if self.history.len() > 50 {
            self.history.remove(0);
        }
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.items.front()
    }

    pub fn remove(&mut self, position: usize) -> Option<QueueEntry> {
        self.items.remove(position)
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn items(&self) -> Vec<QueueEntry> {
        self.items.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn loop_mode(&self) -> LoopMode {
        self.loop_mode
    }

    pub fn set_loop_mode(&mut self, mode: LoopMode) {
        self.loop_mode = mode;
    }

    pub fn move_item(&mut self, from: usize, to: usize) -> bool {
        if from >= self.items.len() || to >= self.items.len() {
            return false;
        }
        if let Some(item) = self.items.remove(from) {
            self.items.insert(to, item);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
