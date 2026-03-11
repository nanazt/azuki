import { useState, useEffect, useRef, useCallback } from "react";
import clsx from "clsx";
import { Search, Loader2, Link, X } from "lucide-react";
import { api } from "../lib/api";
import type { TrackInfo } from "../lib/types";
import { SearchResult } from "../components/features/search/SearchResult";
import { useToast } from "../hooks/useToast";
import { useLocale, t } from "../hooks/useLocale";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { isHttpUrl } from "../lib/url";

type SearchSource = "youtube" | "history";

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
  useLocale();
  const s = t();
  const SOURCES: { id: SearchSource; label: string }[] = [
    { id: "youtube", label: s.search.youtube },
    { id: "history", label: s.search.historySource },
  ];
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchSource>("youtube");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [urlAdding, setUrlAdding] = useState(false);
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    items: results,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
    reload,
    loadMore,
  } = useInfiniteScroll<TrackInfo>({
    fetcher: (cursor) => api.search(submittedQuery, source, cursor),
    enabled: submittedQuery.trim().length > 0,
    scrollRoot: containerRef.current,
  });

  // Reload when submittedQuery or source changes
  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    if (submittedQuery.trim()) reload();
  }, [submittedQuery, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;

      if (isHttpUrl(trimmed)) {
        setUrlAdding(true);
        try {
          await api.addToQueue(trimmed);
          showToast(t().toast.urlAddedToQueue, "success");
          setQuery("");
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : "";
          if (msg.includes("duplicate") || msg.includes("already")) {
            showToast(t().toast.duplicateInQueue, "error");
          } else {
            showToast(t().toast.failedToAddToQueue, "error");
          }
        } finally {
          setUrlAdding(false);
        }
      } else {
        setSubmittedQuery(trimmed);
      }
    },
    [query, showToast],
  );

  const handleAdd = useCallback(
    async (track: TrackInfo) => {
      setAddingIds((prev) => new Set(prev).add(track.id));
      try {
        await api.addToQueue(track.source_url);
        setAddedIds((prev) => new Set(prev).add(track.id));
        setTimeout(() => {
          setAddedIds((prev) => {
            const next = new Set(prev);
            next.delete(track.id);
            return next;
          });
        }, 1500);
      } catch (err) {
        console.error("Failed to add to queue", err);
        showToast(t().toast.failedToAddToQueue, "error");
      } finally {
        setAddingIds((prev) => {
          const next = new Set(prev);
          next.delete(track.id);
          return next;
        });
      }
    },
    [showToast],
  );

  const hasQuery = submittedQuery.trim().length > 0;
  const isUrl = isHttpUrl(query.trim());

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="px-4 pt-4 pb-3 border-b border-[var(--color-border)]">
        <form onSubmit={handleSubmit}>
          <div className="relative">
            <button
              type="submit"
              className={clsx(
                "absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer",
                query.trim()
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-text-tertiary)]",
              )}
            >
              {isUrl ? <Link size={16} /> : <Search size={16} />}
            </button>
            <input
              type="text"
              autoFocus
              data-search-input
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={s.search.placeholder}
              className={clsx(
                "w-full pl-9 pr-10 py-2.5 md:py-2 rounded-lg text-base md:text-sm",
                "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]",
                "text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)]",
                "outline-none focus:border-[var(--color-accent)] transition-colors duration-150",
              )}
            />
            {(loading || loadingMore || urlAdding) && (
              <Loader2
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] animate-spin"
              />
            )}
            {query && !loading && !loadingMore && !urlAdding && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setSubmittedQuery("");
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] cursor-pointer"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </form>

        {/* Source tabs */}
        <div className="flex gap-1 mt-3">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSource(s.id)}
              className={clsx(
                "px-3 py-1.5 md:py-1 rounded-full text-xs font-medium transition-colors duration-150 cursor-pointer touch-manipulation",
                source === s.id
                  ? "bg-[var(--color-accent)] text-[#1a1a1a]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div ref={containerRef} className="flex-1 overflow-y-auto py-2 px-1">
        {loading && results.length === 0 && (
          <div
            className="space-y-1"
            style={{
              animation: "fadeIn var(--duration-normal) var(--ease-out-soft)",
            }}
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        )}

        {!loading && !hasQuery && (
          <div
            className="flex flex-col items-center justify-center gap-2 py-10 text-center"
            style={{
              animation: "fadeIn var(--duration-normal) var(--ease-out-soft)",
            }}
          >
            <Search size={28} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              {s.search.searchPrompt}
            </p>
          </div>
        )}

        {!loading && hasQuery && results.length === 0 && (
          <div
            className="flex flex-col items-center justify-center gap-2 py-10 text-center"
            style={{
              animation: "fadeIn var(--duration-normal) var(--ease-out-soft)",
            }}
          >
            <Search size={28} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              {s.search.noResults}
            </p>
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {s.search.noResultsHint}
            </p>
          </div>
        )}

        {hasQuery && results.length > 0 && (
          <div
            key={`${source}-${submittedQuery}`}
            style={{
              animation: "fadeIn var(--duration-normal) var(--ease-out-soft)",
            }}
          >
            {results.map((track) => (
              <SearchResult
                key={track.id}
                track={track}
                onAdd={handleAdd}
                adding={addingIds.has(track.id)}
                added={addedIds.has(track.id)}
              />
            ))}

            {/* Sentinel + skeleton loading */}
            {hasMore && (
              <div ref={sentinelRef}>
                {loadingMore ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <SkeletonRow key={i} />
                  ))
                ) : (
                  <div className="py-8" />
                )}
              </div>
            )}

            {/* Keyboard fallback */}
            {hasMore && !loadingMore && (
              <button
                onClick={loadMore}
                className="sr-only focus:not-sr-only focus:flex focus:justify-center focus:py-3 focus:text-sm focus:text-[var(--color-text-secondary)] focus:underline w-full"
              >
                {s.search.loadMore}
              </button>
            )}

            {/* End-of-list indicator */}
            {!hasMore && (
              <div className="flex items-center gap-3 px-3 py-6">
                <div className="flex-1 h-px bg-[var(--color-border)]" />
                <span className="text-xs text-[var(--color-text-tertiary)] px-2 shrink-0">
                  {s.search.resultsCount.replace("{n}", String(results.length))}
                </span>
                <div className="flex-1 h-px bg-[var(--color-border)]" />
              </div>
            )}
          </div>
        )}

        {/* Screen reader announcement */}
        <div aria-live="polite" aria-atomic="false" className="sr-only">
          {loadingMore ? s.search.loadingMoreResults : ""}
          {!hasMore && results.length > 0
            ? s.search.allResultsLoaded.replace("{n}", String(results.length))
            : ""}
        </div>
      </div>
    </div>
  );
}
