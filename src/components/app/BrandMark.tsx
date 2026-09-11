import { cn } from "@/lib/utils";

export function BrandMark({ className, size = 40 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("text-primary", className)}
    >
      <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="3.5" />
      <path
        d="M31.5 15.5c-7.6.3-13.2 5.4-13.8 12.9-.1 1.3.1 2.6.5 3.7 6.4-.2 12.3-4.6 13.3-12 .2-1.5.2-3.1 0-4.6Z"
        fill="currentColor"
      />
      <path
        d="M18.5 32.5c2.6-4.3 6-7.5 10.5-10"
        stroke="var(--color-background)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark size={28} />
      <span className="font-display text-xl font-semibold tracking-tight">NutriTrack</span>
    </span>
  );
}
