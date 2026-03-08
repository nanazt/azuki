import clsx from "clsx";

type SkeletonVariant = "text" | "circle" | "rect";

interface SkeletonProps {
  variant?: SkeletonVariant;
  width?: string | number;
  height?: string | number;
  className?: string;
}

export function Skeleton({
  variant = "rect",
  width,
  height,
  className,
}: SkeletonProps) {
  const style: React.CSSProperties = {
    width: typeof width === "number" ? `${width}px` : width,
    height: typeof height === "number" ? `${height}px` : height,
  };

  return (
    <div
      className={clsx(
        "bg-[var(--color-bg-tertiary)]",
        variant === "text" && "rounded h-4",
        variant === "circle" && "rounded-full",
        variant === "rect" && "rounded-md",
        className
      )}
      style={style}
    />
  );
}
