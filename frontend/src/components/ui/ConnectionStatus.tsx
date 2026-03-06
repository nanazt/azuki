import { usePlayerStore } from "../../stores/playerStore";

export function ConnectionStatus() {
  const connected = usePlayerStore((s) => s.connected);

  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: connected ? "0px" : "48px" }}
      aria-live="polite"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/15 border-b border-amber-500/30">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
        </span>
        <span className="text-xs font-medium text-amber-300">Reconnecting…</span>
      </div>
    </div>
  );
}
