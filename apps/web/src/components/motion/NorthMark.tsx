/** The north arrow from the landing page: the one shape the whole brand is built on. Colour comes from the parent. */
export function NorthArrow({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false" className={className} fill="currentColor">
      <path d="M8 0.5 15 15.5 8 11.6 1 15.5z" />
    </svg>
  );
}
