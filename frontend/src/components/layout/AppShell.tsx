import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { QueuePanel } from "../features/queue";
import { MobileTabBar } from "./MobileTabBar";
import { PlayerBar } from "../features/player/PlayerBar";
import { ConnectionStatus } from "../ui/ConnectionStatus";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--color-bg)]">
      {/* Left sidebar — hidden on mobile */}
      <div className="hidden md:flex flex-shrink-0 w-60">
        <Sidebar />
      </div>

      {/* Main content area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ConnectionStatus />
        <div className="flex-1 overflow-y-auto pb-32 md:pb-20">{children}</div>
      </main>

      {/* Right panel — hidden on mobile and tablet */}
      <div className="hidden lg:flex flex-shrink-0 w-[340px] border-l border-[var(--color-border)] flex-col overflow-hidden">
        <QueuePanel />
      </div>

      {/* Fixed bottom player bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30">
        <PlayerBar />
      </div>

      {/* Mobile bottom tab bar — shown only on mobile, above player bar */}
      <div className="md:hidden fixed bottom-[60px] left-0 right-0 z-30">
        <MobileTabBar />
      </div>
    </div>
  );
}
