import { NavLink } from "react-router-dom";
import { BarChart3, Home, Search, Settings, ListMusic } from "lucide-react";
import clsx from "clsx";

interface TabItem {
  to: string;
  icon: React.ReactNode;
  label: string;
}

const TABS: TabItem[] = [
  { to: "/", icon: <Home size={20} />, label: "Home" },
  { to: "/search", icon: <Search size={20} />, label: "Search" },
  { to: "/queue", icon: <ListMusic size={20} />, label: "Queue" },
  { to: "/stats", icon: <BarChart3 size={20} />, label: "Stats" },
  { to: "/settings", icon: <Settings size={20} />, label: "Settings" },
];

export function MobileTabBar() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 h-16 z-30 flex items-center bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)]">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === "/"}
          className={({ isActive }) =>
            clsx(
              "flex-1 flex flex-col items-center justify-center gap-0.5 h-full transition-colors duration-100",
              isActive
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            )
          }
        >
          {tab.icon}
          <span className="text-[10px] font-medium">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
