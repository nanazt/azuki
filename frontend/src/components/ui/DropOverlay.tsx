import { Upload } from "lucide-react";
import { useLocale, t } from "../../hooks/useLocale";

interface Props {
  onSelectFile?: () => void;
}

export function DropOverlay({ onSelectFile }: Props) {
  useLocale();
  const s = t();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-12 border-2 border-dashed border-[var(--color-accent)] rounded-2xl bg-[var(--color-bg-primary)]/80">
        <Upload size={48} className="text-[var(--color-text-secondary)]" />
        <div className="text-center">
          <p className="text-lg font-medium text-[var(--color-text)]">
            {s.upload.dropFileHere}
          </p>
          <p className="text-sm text-[var(--color-text-tertiary)] mt-1">
            {s.upload.supportedFormats}
          </p>
        </div>
        {onSelectFile && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelectFile();
            }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-colors touch-manipulation"
          >
            {s.upload.orSelectFile}
          </button>
        )}
      </div>
    </div>
  );
}
