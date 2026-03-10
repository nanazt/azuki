import { type ReactNode, useState, useEffect, useCallback } from "react";
import { Sidebar } from "./Sidebar";
import { QueuePanel } from "../features/queue";
import { MobileTabBar } from "./MobileTabBar";
import { PlayerBar } from "../features/player/PlayerBar";
import { ConnectionStatus } from "../ui/ConnectionStatus";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);

  const toggleQueueDrawer = useCallback(() => {
    setQueueDrawerOpen((prev) => !prev);
  }, []);

  // Close drawer on ESC
  useEffect(() => {
    if (!queueDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQueueDrawerOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [queueDrawerOpen]);

  // Auto-close drawer when viewport crosses lg breakpoint
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) setQueueDrawerOpen(false);
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-[var(--color-bg)]">
      {/* Top row: sidebar + content + queue panel */}
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — hidden on mobile */}
        <div className="hidden md:flex flex-shrink-0 w-60">
          <Sidebar />
        </div>

        {/* Main content area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <ConnectionStatus />
          <div className="flex-1 overflow-y-auto" data-main-scroll>
            {children}
          </div>
        </main>

        {/* Right panel — hidden on mobile and tablet */}
        <div className="hidden lg:flex flex-shrink-0 w-[340px] border-l border-[var(--color-border)] flex-col overflow-hidden">
          <QueuePanel />
        </div>
      </div>

      {/* Mobile bottom tab bar */}
      <div className="md:hidden flex-shrink-0">
        <MobileTabBar />
      </div>

      {/* Player bar — full width */}
      <div className="flex-shrink-0">
        <PlayerBar
          onToggleQueue={toggleQueueDrawer}
          queueDrawerOpen={queueDrawerOpen}
        />
      </div>

      {/* Queue drawer backdrop — md~lg only */}
      {queueDrawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setQueueDrawerOpen(false)}
        />
      )}

      {/* Queue drawer panel — md~lg only */}
      <div
        className={`fixed top-0 right-0 bottom-0 w-[340px] z-50 lg:hidden bg-[var(--color-bg)] border-l border-[var(--color-border)] flex flex-col overflow-hidden transition-transform duration-300 ease-out ${
          queueDrawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <QueuePanel />
      </div>
    </div>
  );
}
