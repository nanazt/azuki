import { useEffect, useRef, useState, useCallback } from "react";

export type AnimationStatus = "entering" | "stable" | "exiting";

export interface AnimatedItem<T> {
  item: T;
  status: AnimationStatus;
  key: string;
}

const SAFETY_TIMEOUT = 500;

/**
 * Display-layer wrapper that tracks enter/exit animations for list items.
 * Feed it the data source items; it returns displayItems with animation status.
 */
export function useAnimatedList<T>(
  items: T[],
  getKey: (item: T) => string,
): {
  displayItems: AnimatedItem<T>[];
  handleAnimationEnd: (key: string) => void;
} {
  const [displayItems, setDisplayItems] = useState<AnimatedItem<T>[]>(() =>
    items.map((item) => ({
      item,
      key: getKey(item),
      status: "stable" as const,
    })),
  );
  const prevKeysRef = useRef<Set<string>>(new Set(items.map(getKey)));
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    const prevKeys = prevKeysRef.current;
    const currentKeys = new Set(items.map(getKey));
    const currentMap = new Map(items.map((item) => [getKey(item), item]));

    // Items that were present before but are gone now -> exiting
    const exitingKeys = new Set<string>();
    for (const key of prevKeys) {
      if (!currentKeys.has(key)) exitingKeys.add(key);
    }

    // Items that are new -> entering
    const enteringKeys = new Set<string>();
    for (const key of currentKeys) {
      if (!prevKeys.has(key)) enteringKeys.add(key);
    }

    setDisplayItems((prev) => {
      // Current items with entering/stable status
      const currentItems: AnimatedItem<T>[] = items.map((item) => {
        const key = getKey(item);
        return {
          item,
          key,
          status: enteringKeys.has(key)
            ? ("entering" as const)
            : ("stable" as const),
        };
      });

      // Collect exiting items from previous list
      const exitingList: AnimatedItem<T>[] = [];
      const addedKeys = new Set<string>();

      for (const prevItem of prev) {
        if (currentMap.has(prevItem.key)) continue;
        if (exitingKeys.has(prevItem.key) || prevItem.status === "exiting") {
          if (!addedKeys.has(prevItem.key)) {
            exitingList.push({ ...prevItem, status: "exiting" });
            addedKeys.add(prevItem.key);
          }
        }
      }

      // Current items first, exiting items appended
      const finalResult: AnimatedItem<T>[] = [];
      for (const ci of currentItems) {
        finalResult.push(ci);
      }
      for (const ei of exitingList) {
        finalResult.push(ei);
      }

      return finalResult;
    });

    // Set safety timeouts for exiting items
    for (const key of exitingKeys) {
      if (!exitTimers.current.has(key)) {
        exitTimers.current.set(
          key,
          setTimeout(() => {
            setDisplayItems((prev) => prev.filter((d) => d.key !== key));
            exitTimers.current.delete(key);
          }, SAFETY_TIMEOUT),
        );
      }
    }

    prevKeysRef.current = currentKeys;
  }, [items, getKey]);

  const handleAnimationEnd = useCallback((key: string) => {
    // Clear safety timer
    const timer = exitTimers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      exitTimers.current.delete(key);
    }

    setDisplayItems((prev) => {
      return prev
        .filter((d) => !(d.key === key && d.status === "exiting"))
        .map((d) =>
          d.key === key && d.status === "entering"
            ? { ...d, status: "stable" as const }
            : d,
        );
    });
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  return { displayItems, handleAnimationEnd };
}
