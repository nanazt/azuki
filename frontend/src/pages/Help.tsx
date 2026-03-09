import {
  HelpCircle,
  Search,
  Clock,
  Upload,
  BarChart3,
  Play,
  ClipboardPaste,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Command {
  name: string;
  args?: string;
  description?: string;
}

interface CommandCluster {
  label: string;
  commands: Command[];
}

const commandClusters: CommandCluster[] = [
  {
    label: "Playback",
    commands: [
      {
        name: "play",
        args: "<query or URL>",
        description: "대기 중이면 즉시 재생, 재생 중이면 대기열에 추가",
      },
      { name: "pause" },
      { name: "resume" },
      { name: "skip" },
    ],
  },
  {
    label: "Queue & Settings",
    commands: [
      { name: "queue" },
      { name: "now" },
      { name: "volume", args: "<0–100>" },
      { name: "loop", args: "<off | one | all>" },
    ],
  },
];

interface WebFeature {
  icon: LucideIcon;
  label: string;
  description: string;
}

const webFeatures: WebFeature[] = [
  {
    icon: Search,
    label: "Search",
    description: "Search YouTube or history and add to queue",
  },
  {
    icon: Clock,
    label: "History",
    description: "View play history, re-add tracks to queue",
  },
  {
    icon: Upload,
    label: "Uploads",
    description: "Drag & drop audio files, edit metadata",
  },
  {
    icon: BarChart3,
    label: "Stats",
    description: "Heatmap, trends, top tracks & artists",
  },
  {
    icon: Play,
    label: "Player",
    description: "Play/pause, skip, seek, volume, loop modes",
  },
  {
    icon: ClipboardPaste,
    label: "Paste to Play",
    description: "Paste a link anywhere to add it to the queue",
  },
];

interface Shortcut {
  keys: string[];
  description: string;
}

const shortcuts: Shortcut[] = [
  { keys: ["Space"], description: "Play / Pause" },
  { keys: ["\u2190", "\u2192"], description: "Seek backward / forward" },
  { keys: ["\u2191", "\u2193"], description: "Volume up / down" },
  { keys: ["M"], description: "Mute / Unmute" },
  { keys: ["/"], description: "Go to Search" },
];

function CommandsCard() {
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "0ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        Discord Commands
      </h2>
      <div className="flex flex-col">
        {commandClusters.map((cluster, ci) => (
          <div key={cluster.label}>
            {ci > 0 && (
              <div className="border-t border-[var(--color-border)]/50 my-3" />
            )}
            <div className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wide border-l-2 border-[var(--color-accent)]/40 pl-2 mb-2">
              {cluster.label}
            </div>
            <div className="flex flex-col font-mono text-sm">
              {cluster.commands.map((cmd) => (
                <div
                  key={cmd.name}
                  className="flex flex-col px-3 py-2 min-h-[44px] rounded-lg justify-center"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-[var(--color-text-tertiary)]">/</span>
                    <span className="font-medium text-[var(--color-text)]">
                      {cmd.name}
                    </span>
                    {cmd.args && (
                      <span className="text-xs text-[var(--color-text-tertiary)] ml-auto">
                        {cmd.args}
                      </span>
                    )}
                  </div>
                  {cmd.description && (
                    <div className="text-xs text-[var(--color-text-tertiary)] font-sans ml-5 mt-0.5">
                      {cmd.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WebFeaturesCard() {
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "60ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        Web Features
      </h2>
      <div className="flex flex-col gap-3">
        {webFeatures.map((feature) => (
          <div key={feature.label} className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
              <feature.icon
                size={14}
                className="text-[var(--color-text-secondary)]"
              />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)]">
                {feature.label}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)]">
                {feature.description}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortcutsCard() {
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "120ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        Keyboard Shortcuts
      </h2>
      <div className="flex flex-col gap-2.5">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.description} className="flex items-center gap-3">
            <div className="min-w-[80px] flex gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="inline-flex items-center justify-center min-w-[28px] h-7 px-2 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] border-b-2 text-xs font-mono text-[var(--color-text-secondary)] shadow-sm"
                >
                  {key}
                </kbd>
              ))}
            </div>
            <span className="text-xs text-[var(--color-text-secondary)]">
              {shortcut.description}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Help() {
  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-4 pb-32 md:pb-6">
      <h1 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2">
        <HelpCircle size={20} className="text-[var(--color-text-secondary)]" />
        Help
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WebFeaturesCard />
        <ShortcutsCard />
      </div>
      <CommandsCard />
    </div>
  );
}
