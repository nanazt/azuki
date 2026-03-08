import { useState, useEffect, useRef, useCallback } from "react";
import clsx from "clsx";
import { Search, Loader2 } from "lucide-react";
import { api } from "../../../lib/api";
import type { TrackInfo } from "../../../lib/types";
import { SearchResult } from "./SearchResult";
import { useToast } from "../../../hooks/useToast";

type SearchSource = "youtube" | "history" | "playlists";

const SOURCES: { id: SearchSource; label: string }[] = [
  { id: "youtube", label: "YouTube" },
  { id: "history", label: "History" },
  { id: "playlists", label: "Playlists" },
];

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="w-12 h-12 rounded bg-[var(--color-bg-tertiary)] animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3 bg-[var(--color-bg-tertiary)] rounded animate-pulse w-3/4" />
        <div className="h-3 bg-[var(--color-bg-tertiary)] rounded animate-pulse w-1/2" />
      </div>
    </div>
  );
}

export function SearchPage() {
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchSource>("youtube");
  const [results, setResults] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestQueryRef = useRef("");

  const runSearch = useCallback(async (q: string, src: SearchSource) => {
    if (!q.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.search(q, src);
      // Only update if this is still the latest query
      if (q === latestQueryRef.current) {
        setResults(data.results);
      }
    } catch (err) {
      if (q === latestQueryRef.current) {
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      }
    } finally {
      if (q === latestQueryRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    latestQueryRef.current = query;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = setTimeout(() => {
      runSearch(query, source);
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, source, runSearch]);

  const handleAdd = useCallback(async (track: TrackInfo) => {
    setAddingIds((prev) => new Set(prev).add(track.id));
    try {
      await api.addToQueue(track.source_url);
    } catch (err) {
      console.error("Failed to add to queue", err);
      showToast("Failed to add to queue", "error");
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  }, [showToast]);

  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="px-4 pt-4 pb-3 border-b border-[var(--color-border)]">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] pointer-events-none"
          />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for music…"
            className={clsx(
              "w-full pl-9 pr-4 py-2.5 md:py-2 rounded-lg text-base md:text-sm",
              "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]",
              "text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)]",
              "outline-none focus:border-[var(--color-accent)] transition-colors duration-150"
            )}
          />
          {loading && (
            <Loader2
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] animate-spin"
            />
          )}
        </div>

        {/* Source tabs */}
        <div className="flex gap-1 mt-3">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSource(s.id)}
              className={clsx(
                "px-3 py-1.5 md:py-1 rounded-full text-xs font-medium transition-colors duration-150 cursor-pointer touch-manipulation",
                source === s.id
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto py-2 px-1">
        {loading && results.length === 0 && (
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-[var(--color-danger)]">{error}</p>
          </div>
        )}

        {!loading && !error && hasQuery && results.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Search size={28} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">No results found</p>
            <p className="text-xs text-[var(--color-text-tertiary)]">
              Try a different search term or source
            </p>
          </div>
        )}

        {!loading && !error && !hasQuery && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Search size={28} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              Search for songs, artists, or URLs
            </p>
          </div>
        )}

        {results.length > 0 && (
          <div>
            {results.map((track) => (
              <SearchResult
                key={track.id}
                track={track}
                onAdd={handleAdd}
                adding={addingIds.has(track.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
