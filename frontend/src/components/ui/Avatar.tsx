import clsx from "clsx";

type AvatarSize = "xs" | "sm" | "md" | "lg";

interface AvatarProps {
  src?: string | null;
  username: string;
  size?: AvatarSize;
  className?: string;
}

const sizeClasses: Record<AvatarSize, string> = {
  xs: "w-3.5 h-3.5 text-[8px]",
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-xs",
  lg: "w-12 h-12 text-base",
};

export function Avatar({ src, username, size = "md", className }: AvatarProps) {
  const initial = username ? username[0].toUpperCase() : "?";

  return (
    <div
      className={clsx(
        "rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 select-none font-semibold",
        "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]",
        sizeClasses[size],
        className
      )}
      title={username}
    >
      {src ? (
        <img
          src={src}
          alt={username}
          className="w-full h-full object-cover"
          onError={(e) => {
            // Hide broken image, show initial fallback
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}
