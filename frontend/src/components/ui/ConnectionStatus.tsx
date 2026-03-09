import { usePlayerStore } from "../../stores/playerStore";

export function ConnectionStatus() {
  const connected = usePlayerStore((s) => s.connected);
  const hasConnected = usePlayerStore((s) => s.hasConnected);

  const show = hasConnected && !connected;

  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: show ? "48px" : "0px" }}
      aria-live="polite"
      role="status"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-warning-bg border-warning-border">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
        </span>
        <span className="text-xs font-medium text-warning">Reconnecting…</span>
      </div>
    </div>
  );
}
