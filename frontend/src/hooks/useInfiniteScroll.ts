import { useState, useEffect, useCallback, useRef } from "react";

interface UseInfiniteScrollOptions<
  T,
  R extends { items: T[]; next_cursor: string | null },
> {
  fetcher: (cursor?: string) => Promise<R>;
  onResponse?: (response: R) => void;
  enabled?: boolean;
  rootRef?: React.RefObject<Element | null>;
}

interface UseInfiniteScrollReturn<T> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reload: () => void;
  loadMore: () => void;
}

export function useInfiniteScroll<
  T,
  R extends { items: T[]; next_cursor: string | null } = {
    items: T[];
    next_cursor: string | null;
  },
>(options: UseInfiniteScrollOptions<T, R>): UseInfiniteScrollReturn<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Store fetcher/onResponse in refs to avoid deps instability
  const fetcherRef = useRef(options.fetcher);
  fetcherRef.current = options.fetcher;
  const onResponseRef = useRef(options.onResponse);
  onResponseRef.current = options.onResponse;

  // Track loading and cursor in refs to prevent observer churn
  const loadingMoreRef = useRef(false);
  const cursorRef = useRef<string | null>(null);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !cursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetcherRef.current(cursorRef.current);
      onResponseRef.current?.(res);
      setItems((prev) => [...prev, ...res.items]);
      cursorRef.current = res.next_cursor;
      setHasMore(res.next_cursor !== null);
    } catch {
      // ignore
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    cursorRef.current = null;
    try {
      const res = await fetcherRef.current();
      onResponseRef.current?.(res);
      setItems(res.items);
      cursorRef.current = res.next_cursor;
      setHasMore(res.next_cursor !== null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load (re-run when enabled changes)
  useEffect(() => {
    if (options.enabled === false) {
      setItems([]);
      setLoading(false);
      setHasMore(false);
      cursorRef.current = null;
      return;
    }
    reload();
  }, [options.enabled, reload]);

  // IntersectionObserver with rootRef support
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore();
      },
      {
        root: options.rootRef?.current ?? null,
        threshold: 0,
        rootMargin: "0px 0px 80px 0px",
      },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, options.rootRef]);

  return {
    items,
    setItems,
    loading,
    loadingMore,
    hasMore,
    sentinelRef,
    reload,
    loadMore,
  };
}
