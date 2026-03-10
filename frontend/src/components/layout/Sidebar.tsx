import { NavLink } from "react-router-dom";
import {
  BarChart3,
  Clock,
  HelpCircle,
  Home,
  Search,
  Settings,
  Upload,
  Users,
} from "lucide-react";
import clsx from "clsx";
import { Avatar } from "../ui/Avatar";
import { usePlayerStore } from "../../stores/playerStore";
import { useLocale, t } from "../../hooks/useLocale";

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  indent?: boolean;
  end?: boolean;
}

function NavItem({ to, icon, label, indent, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors duration-100",
          indent && "ml-4",
          isActive
            ? "bg-[var(--color-bg-hover)] text-[var(--color-text)] font-medium"
            : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]",
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
  useLocale();
  const s = t();
  const listeners = usePlayerStore((s) => s.listeners);

  return (
    <aside className="flex flex-col w-60 h-full bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] overflow-y-auto">
      {/* Logo */}
      <div className="px-4 py-5 flex-shrink-0">
        <span className="text-base font-bold text-[var(--color-text)] tracking-tight">
          azuki
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-1">
        <NavItem to="/" icon={<Home size={16} />} label={s.nav.home} end />
        <NavItem
          to="/search"
          icon={<Search size={16} />}
          label={s.nav.search}
        />

        {/* Library */}
        <div className="mt-4 space-y-0.5">
          <NavItem
            to="/history"
            icon={<Clock size={16} />}
            label={s.nav.history}
          />
          <NavItem
            to="/uploads"
            icon={<Upload size={16} />}
            label={s.nav.uploads}
          />
          <NavItem
            to="/stats"
            icon={<BarChart3 size={16} />}
            label={s.nav.stats}
          />
        </div>
      </nav>

      {/* Help & Settings */}
      <div className="px-2 py-2 border-t border-[var(--color-border)] flex-shrink-0">
        <NavItem
          to="/help"
          icon={<HelpCircle size={16} />}
          label={s.nav.help}
        />
        <NavItem
          to="/settings"
          icon={<Settings size={16} />}
          label={s.nav.settings}
        />
      </div>

      {/* Listeners */}
      {listeners.length > 0 && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] mb-2">
            <Users size={12} />
            <span>
              {s.common.listening.replace("{n}", String(listeners.length))}
            </span>
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
