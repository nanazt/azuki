import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import clsx from "clsx";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional prefix rendered in accent color (e.g. "#" for channels) */
  prefix?: string;
}

interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Icon rendered left of the selected label in the trigger */
  icon?: React.ReactNode;
}

const DROPDOWN_MAX_HEIGHT = 280;
const DROPDOWN_MARGIN = 8; // extra breathing room in px

export function Select({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled = false,
  className,
  icon,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  function handleToggle() {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < DROPDOWN_MAX_HEIGHT + DROPDOWN_MARGIN);
    }
    setOpen((v) => !v);
  }

  function handleSelect(optValue: string) {
    onChange(optValue);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={clsx("relative", className)}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          "w-full min-h-[44px] px-3 py-2 rounded-lg text-sm",
          "flex items-center gap-2",
          "bg-[var(--color-bg)] border transition-colors duration-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)]",
          open
            ? "border-[var(--color-accent)]"
            : "border-[var(--color-border)] hover:border-[var(--color-text-tertiary)]",
          disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
        )}
      >
        {/* Left icon slot */}
        {icon && (
          <span className="flex-shrink-0 text-[var(--color-text-tertiary)]">
            {icon}
          </span>
        )}

        {/* Label */}
        <span
          className={clsx(
            "flex-1 text-left truncate",
            selected
              ? "text-[var(--color-text)]"
              : "text-[var(--color-text-tertiary)]",
          )}
        >
          {selected ? (
            <>
              {selected.prefix && (
                <span className="text-[var(--color-text-secondary)]">
                  {selected.prefix}
                </span>
              )}
              {selected.label}
            </>
          ) : (
            placeholder
          )}
        </span>

        {/* Chevron */}
        <ChevronDown
          size={14}
          className={clsx(
            "flex-shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="listbox"
          className={clsx(
            "absolute z-50 left-0 right-0",
            openUpward ? "bottom-full mb-1.5" : "top-full mt-1",
            "rounded-lg border border-[var(--color-border)]",
            "bg-[var(--color-bg-secondary)]",
            "shadow-[0_8px_24px_rgba(0,0,0,0.5)]",
            "overflow-hidden",
            // Max height with scroll for long lists (timezones)
            "max-h-[280px] overflow-y-auto",
            // Custom scrollbar matching app style
            "[&::-webkit-scrollbar]:w-[6px]",
            "[&::-webkit-scrollbar-track]:bg-transparent",
            "[&::-webkit-scrollbar-thumb]:rounded-full",
            "[&::-webkit-scrollbar-thumb]:bg-[var(--color-border)]",
          )}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                role="option"
                type="button"
                aria-selected={isSelected}
                onClick={() => handleSelect(opt.value)}
                className={clsx(
                  "w-full min-h-[44px] px-3 py-2.5",
                  "flex items-center gap-2 text-sm text-left",
                  "transition-colors duration-75 cursor-pointer",
                  "focus-visible:outline-none focus-visible:bg-[var(--color-bg-hover)]",
                  isSelected
                    ? "text-[var(--color-text)] bg-[var(--color-bg-tertiary)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]",
                )}
              >
                {/* Accent bar for selected */}
                <span
                  className={clsx(
                    "flex-shrink-0 self-stretch w-0.5 rounded-full transition-colors duration-100",
                    isSelected ? "bg-[var(--color-accent)]" : "bg-transparent",
                  )}
                />

                {/* Label */}
                <span className="flex-1 truncate">
                  {opt.prefix && (
                    <span
                      className={clsx(
                        isSelected
                          ? "text-[var(--color-text)]"
                          : "text-[var(--color-text-tertiary)]",
                      )}
                    >
                      {opt.prefix}
                    </span>
                  )}
                  {opt.label}
                </span>

                {/* Check icon */}
                {isSelected && (
                  <Check
                    size={13}
                    className="flex-shrink-0 text-[var(--color-text)]"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
