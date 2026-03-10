import {
  HelpCircle,
  Search,
  Clock,
  Upload,
  BarChart3,
  Play,
  ClipboardPaste,
  Home,
  Settings,
  FileAudio,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLocale, t } from "../hooks/useLocale";

interface Command {
  name: string;
  args?: string;
  descriptionKey: keyof ReturnType<typeof t>["help"]["commands"];
}

interface CommandCluster {
  labelKey: keyof ReturnType<typeof t>["help"]["commandClusters"];
  commands: Command[];
}

const commandClusters: CommandCluster[] = [
  {
    labelKey: "playback",
    commands: [
      { name: "play", args: "<query or URL>", descriptionKey: "play" },
      { name: "pause", descriptionKey: "pause" },
      { name: "resume", descriptionKey: "resume" },
      { name: "skip", descriptionKey: "skip" },
      { name: "now", descriptionKey: "now" },
    ],
  },
  {
    labelKey: "settings",
    commands: [
      { name: "volume", args: "<0\u2013100>", descriptionKey: "volume" },
      { name: "loop", args: "<off | one | all>", descriptionKey: "loop" },
    ],
  },
];

interface WebFeature {
  icon: LucideIcon;
  labelKey: keyof ReturnType<typeof t>["help"]["featureLabels"];
  descriptionKey: keyof ReturnType<typeof t>["help"]["features"];
}

const webFeatures: WebFeature[] = [
  { icon: Home, labelKey: "home", descriptionKey: "home" },
  { icon: Search, labelKey: "search", descriptionKey: "search" },
  { icon: Play, labelKey: "player", descriptionKey: "player" },
  { icon: Clock, labelKey: "history", descriptionKey: "history" },
  { icon: Upload, labelKey: "uploads", descriptionKey: "uploads" },
  { icon: FileAudio, labelKey: "dragAndDrop", descriptionKey: "dragAndDrop" },
  {
    icon: ClipboardPaste,
    labelKey: "pasteToPlay",
    descriptionKey: "pasteToPlay",
  },
  { icon: BarChart3, labelKey: "stats", descriptionKey: "stats" },
  { icon: Settings, labelKey: "settings", descriptionKey: "settings" },
];

interface ShortcutDef {
  keys: string[];
  descriptionKey: keyof ReturnType<typeof t>["help"]["shortcuts"];
}

const shortcutDefs: ShortcutDef[] = [
  { keys: ["Space"], descriptionKey: "playPause" },
  { keys: ["\u2190", "\u2192"], descriptionKey: "seekBackForward" },
  { keys: ["\u2191", "\u2193"], descriptionKey: "volumeUpDown" },
  { keys: ["M"], descriptionKey: "muteUnmute" },
  { keys: ["/"], descriptionKey: "goToSearch" },
];

function CommandsCard() {
  const s = t();
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "0ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        {s.help.discordCommands}
      </h2>
      <div className="flex flex-col">
        {commandClusters.map((cluster, ci) => (
          <div key={cluster.labelKey}>
            {ci > 0 && (
              <div className="border-t border-[var(--color-border)]/50 my-3" />
            )}
            <div className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wide border-l-2 border-[var(--color-accent)]/40 pl-2 mb-2">
              {s.help.commandClusters[cluster.labelKey]}
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
                  <div className="text-xs text-[var(--color-text-tertiary)] font-sans ml-5 mt-0.5">
                    {s.help.commands[cmd.descriptionKey]}
                  </div>
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
  const s = t();
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "60ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        {s.help.webFeatures}
      </h2>
      <div className="flex flex-col gap-3">
        {webFeatures.map((feature) => (
          <div key={feature.labelKey} className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-md bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
              <feature.icon
                size={14}
                className="text-[var(--color-text-secondary)]"
              />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)]">
                {s.help.featureLabels[feature.labelKey]}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)]">
                {s.help.features[feature.descriptionKey]}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortcutsCard() {
  const s = t();
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "120ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        {s.help.keyboardShortcuts}
      </h2>
      <div className="flex flex-col gap-2.5">
        {shortcutDefs.map((shortcut) => (
          <div
            key={shortcut.descriptionKey}
            className="flex items-center gap-3"
          >
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
              {s.help.shortcuts[shortcut.descriptionKey]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Help() {
  useLocale();
  const s = t();

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-4 pb-6">
      <h1 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2">
        <HelpCircle size={20} className="text-[var(--color-text-secondary)]" />
        {s.help.title}
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WebFeaturesCard />
        <ShortcutsCard />
      </div>
      <CommandsCard />
    </div>
  );
}
