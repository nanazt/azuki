import { useState, useEffect, useCallback } from "react";
import { Upload, Plus, Loader2, Trash2 } from "lucide-react";
import clsx from "clsx";
import { api } from "../../../lib/api";
import { useToast } from "../../../hooks/useToast";
import { useAuthStore } from "../../../stores/authStore";
import type { TrackInfo } from "../../../lib/types";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function UploadRow({
  track,
  onUpdate,
  isAdmin,
  onDelete,
}: {
  track: TrackInfo;
  onUpdate: () => void;
  isAdmin: boolean;
  onDelete: (id: string) => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState<"title" | "artist" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleEdit = (field: "title" | "artist") => {
    setEditing(field);
    setEditValue(field === "title" ? track.title : track.artist || "");
  };

  const handleSave = async () => {
    if (!editing) return;
    try {
      await api.updateTrack(track.id, { [editing]: editValue.trim() || undefined });
      onUpdate();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "error");
    }
    setEditing(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(null);
  };

  const handleAddToQueue = async () => {
    setAdding(true);
    try {
      await api.addTrackToQueue(track.id);
      showToast("Added to queue", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteTrack(track.id);
      onDelete(track.id);
      showToast("Deleted", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Delete failed", "error");
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-hover)] rounded-md group transition-colors">
      {/* Icon */}
      <div className="w-10 h-10 rounded bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
        <Upload size={16} className="text-[var(--color-text-tertiary)]" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {editing === "title" ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="w-full text-sm bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text)] outline-none"
          />
        ) : (
          <p
            className="text-sm text-[var(--color-text)] truncate cursor-pointer hover:underline"
            onClick={() => handleEdit("title")}
          >
            {track.title}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          {editing === "artist" ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-tertiary)] outline-none"
            />
          ) : (
            <span
              className="truncate cursor-pointer hover:underline"
              onClick={() => handleEdit("artist")}
            >
              {track.artist || "Unknown artist"}
            </span>
          )}
          {track.duration_ms > 0 && (
            <>
              <span>·</span>
              <span>{formatDuration(track.duration_ms)}</span>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className={clsx(
        "flex items-center gap-1",
        !confirmDelete && "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        (adding || deleting) && "opacity-100",
        confirmDelete && "opacity-100",
      )}>
        {confirmDelete ? (
          <>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="px-2 py-1.5 text-xs rounded-md transition-colors touch-manipulation min-h-[44px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-2 py-1.5 text-xs rounded-md transition-colors touch-manipulation min-h-[44px] text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 font-medium"
            >
              {deleting ? <Loader2 size={16} className="animate-spin" /> : "Delete?"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleAddToQueue}
              disabled={adding}
              className={clsx(
                "p-2 rounded-md transition-colors touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center",
                "text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)]",
              )}
              aria-label="Add to queue"
            >
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            </button>
            {isAdmin && (
              <button
                onClick={() => setConfirmDelete(true)}
                className={clsx(
                  "p-2 rounded-md transition-colors touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center",
                  "text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
                )}
                aria-label="Delete track"
              >
                <Trash2 size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function UploadsPage() {
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const isAdmin = useAuthStore((s) => s.isAdmin);

  const fetchUploads = useCallback(async (cursor?: string) => {
    if (!cursor) setLoading(true);
    else setLoadingMore(true);
    try {
      const data = await api.getUploads(cursor);
      setTracks((prev) => (cursor ? [...prev, ...data.items] : data.items));
      setTotal(data.total);
      setNextCursor(data.next_cursor);
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  const handleDelete = useCallback((id: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== id));
    setTotal((t) => t - 1);
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Uploads</h1>
        {total > 0 && (
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {total} uploaded tracks
          </p>
        )}
      </div>

      {loading && tracks.length === 0 && (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={24} className="text-[var(--color-text-tertiary)] animate-spin" />
        </div>
      )}

      {!loading && tracks.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Upload size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">
            No uploaded files yet
          </p>
          <p className="text-sm text-[var(--color-text-tertiary)]">
            Drag and drop audio files to upload
          </p>
        </div>
      )}

      {tracks.map((track) => (
        <UploadRow
          key={track.id}
          track={track}
          onUpdate={fetchUploads}
          isAdmin={isAdmin}
          onDelete={handleDelete}
        />
      ))}

      {/* Load more */}
      {nextCursor && (
        <div className="flex items-center justify-center py-4">
          <button
            onClick={() => fetchUploads(nextCursor)}
            disabled={loadingMore}
            className="px-4 py-1.5 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
