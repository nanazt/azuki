import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Heart,
  ListMusic,
  Search,
  Settings,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { Avatar } from "../ui/Avatar";
import { usePlayerStore } from "../../stores/playerStore";

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  indent?: boolean;
}

function NavItem({ to, icon, label, indent }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors duration-100",
          indent && "ml-4",
          isActive
            ? "bg-[var(--color-bg-hover)] text-[var(--color-text)] font-medium"
            : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
        )
      }
    >
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {icon}
      </span>
      {label}
    </NavLink>
  );
}

export function Sidebar() {
  const [libraryOpen, setLibraryOpen] = useState(true);
  const listeners = usePlayerStore((s) => s.listeners);

  return (
    <aside className="flex flex-col w-60 h-full bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] overflow-y-auto pb-20">
      {/* Logo */}
      <div className="px-4 py-5 flex-shrink-0">
        <span className="text-base font-bold text-[var(--color-text)] tracking-tight">
          azuki
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-1">
        <NavItem to="/search" icon={<Search size={16} />} label="Search" />

        {/* Library section */}
        <div className="mt-4">
          <button
            onClick={() => setLibraryOpen((v) => !v)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            {libraryOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Library
          </button>

          {libraryOpen && (
            <div className="mt-1 space-y-0.5">
              <NavItem
                to="/playlists"
                icon={<ListMusic size={16} />}
                label="Playlists"
                indent
              />
              <NavItem
                to="/favorites"
                icon={<Heart size={16} />}
                label="Favorites"
                indent
              />
              <NavItem
                to="/history"
                icon={<Clock size={16} />}
                label="History"
                indent
              />
            </div>
          )}
        </div>

        <div className="mt-2">
          <NavItem to="/stats" icon={<BarChart3 size={16} />} label="Stats" />
        </div>
      </nav>

      {/* Settings */}
      <div className="px-2 py-2 border-t border-[var(--color-border)] flex-shrink-0">
        <NavItem to="/settings" icon={<Settings size={16} />} label="Settings" />
      </div>

      {/* Listeners */}
      {listeners.length > 0 && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] mb-2">
            <Users size={12} />
            <span>{listeners.length} listening</span>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {listeners.slice(0, 6).map((user) => (
              <Avatar
                key={user.id}
                src={user.avatar_url}
                username={user.username}
                size="sm"
              />
            ))}
            {listeners.length > 6 && (
              <span className="text-xs text-[var(--color-text-tertiary)]">
                +{listeners.length - 6}
              </span>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
