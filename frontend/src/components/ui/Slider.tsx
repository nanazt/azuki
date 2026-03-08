import React, { useCallback, useRef } from "react";
import clsx from "clsx";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
  className?: string;
  "aria-label"?: string;
}

export function Slider({
  value,
  min,
  max,
  onChange,
  onChangeEnd,
  className,
  "aria-label": ariaLabel,
}: SliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const range = max - min;
  const pct = range > 0 ? ((value - min) / range) * 100 : 0;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(Number(e.target.value));
    },
    [onChange]
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLInputElement>) => {
      if (onChangeEnd) {
        onChangeEnd(Number((e.target as HTMLInputElement).value));
      }
    },
    [onChangeEnd]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLInputElement>) => {
      if (onChangeEnd) {
        onChangeEnd(Number((e.target as HTMLInputElement).value));
      }
    },
    [onChangeEnd]
  );

  return (
    <div className={clsx("relative flex items-center h-4 group", className)}>
      {/* Track background */}
      <div className="absolute inset-x-0 h-1 rounded-full bg-[var(--color-bg-tertiary)]" />
      {/* Track fill */}
      <div
        className="absolute left-0 h-1 rounded-full bg-[var(--color-accent)] pointer-events-none"
        style={{ width: `${pct}%` }}
      />
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={handleChange}
        onMouseUp={handleMouseUp}
        onTouchEnd={handleTouchEnd}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={ariaLabel}
        className={clsx(
          "absolute inset-x-0 w-full h-full opacity-0 cursor-pointer",
          "slider-input"
        )}
        style={{ margin: 0 }}
      />
      {/* Visible thumb */}
      <div
        className="absolute w-3 h-3 rounded-full bg-white shadow-md pointer-events-none transition-transform duration-100 group-hover:scale-125"
        style={{ left: `calc(${pct}% - 6px)` }}
      />
    </div>
  );
}
