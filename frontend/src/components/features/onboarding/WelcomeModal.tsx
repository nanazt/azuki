import { useNavigate } from "react-router-dom";
import { Music } from "lucide-react";
import { Modal } from "../../ui/Modal";
import { useLocale, t } from "../../../hooks/useLocale";

interface WelcomeModalProps {
  open: boolean;
  onClose: () => void;
}

export function WelcomeModal({ open, onClose }: WelcomeModalProps) {
  useLocale();
  const s = t();
  const navigate = useNavigate();

  const dismiss = () => {
    localStorage.setItem("azuki-welcome-dismissed", "1");
    onClose();
  };

  return (
    <Modal open={open} onClose={dismiss}>
      <div className="flex flex-col items-center text-center gap-4">
        <div className="w-10 h-10 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center">
          <Music size={20} className="text-[var(--color-accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            azuki
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {s.welcome.subtitle}
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full mt-2">
          <button
            onClick={() => {
              dismiss();
              navigate("/help");
            }}
            className="min-h-[44px] w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-opacity cursor-pointer"
          >
            {s.welcome.viewHelp}
          </button>
          <button
            onClick={dismiss}
            className="min-h-[44px] w-full px-4 py-2.5 rounded-lg text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer"
          >
            {s.welcome.getStarted}
          </button>
        </div>
      </div>
    </Modal>
  );
}
