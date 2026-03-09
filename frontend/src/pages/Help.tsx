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
      { name: "pause", description: "일시 정지" },
      { name: "resume", description: "재생 재개" },
      { name: "skip", description: "다음 곡으로 건너뛰기" },
      { name: "now", description: "현재 재생 중인 곡 표시" },
    ],
  },
  {
    label: "Settings",
    commands: [
      { name: "volume", args: "<0–100>", description: "볼륨 조절" },
      {
        name: "loop",
        args: "<off | one | all>",
        description: "반복 모드 설정",
      },
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
    icon: Home,
    label: "Home",
    description: "최근 재생 기록과 빠른 접근",
  },
  {
    icon: Search,
    label: "Search",
    description: "YouTube 검색 또는 재생 기록에서 곡 추가",
  },
  {
    icon: Play,
    label: "Player",
    description: "재생/일시정지, 건너뛰기, 탐색, 볼륨, 반복 모드",
  },
  {
    icon: Clock,
    label: "History",
    description: "재생 기록 확인, 다시 대기열에 추가",
  },
  {
    icon: Upload,
    label: "Uploads",
    description: "오디오 파일 업로드, 메타데이터 편집",
  },
  {
    icon: FileAudio,
    label: "Drag & Drop",
    description: "오디오 파일을 드래그 앤 드롭으로 업로드",
  },
  {
    icon: ClipboardPaste,
    label: "Paste to Play",
    description: "링크를 붙여넣기하면 대기열에 추가",
  },
  {
    icon: BarChart3,
    label: "Stats",
    description: "히트맵, 트렌드, 인기 곡 & 아티스트",
  },
  {
    icon: Settings,
    label: "Settings",
    description: "테마, 언어 등 환경 설정",
  },
];

interface Shortcut {
  keys: string[];
  description: string;
}

const shortcuts: Shortcut[] = [
  { keys: ["Space"], description: "재생 / 일시정지" },
  { keys: ["\u2190", "\u2192"], description: "5초 뒤로 / 앞으로 탐색" },
  { keys: ["\u2191", "\u2193"], description: "볼륨 올리기 / 내리기" },
  { keys: ["M"], description: "음소거 / 해제" },
  { keys: ["/"], description: "검색으로 이동" },
];

function CommandsCard() {
  return (
    <div
      className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 animate-[fadeIn_0.3s_ease-out]"
      style={{ animationDelay: "0ms", animationFillMode: "both" }}
    >
      <h2 className="text-sm font-semibold text-[var(--color-text)] mb-3">
        디스코드 명령어
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
        웹 기능
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
        키보드 단축키
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
        도움말
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WebFeaturesCard />
        <ShortcutsCard />
      </div>
      <CommandsCard />
    </div>
  );
}
