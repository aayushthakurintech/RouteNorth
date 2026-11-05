/** The RouteNorth mark: an N drawn as one route, ending in a destination dot. Colours come from tokens so it works in every theme. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--logo-bg, var(--brand))" />
      <path d="M9 23V9l14 14V9" fill="none" stroke="var(--logo-fg, #fff)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23" cy="9" r="3" fill="#f2a900" />
    </svg>
  );
}

export function Logo({ size = 28, name = "RouteNorth", href }: { size?: number; name?: string; href?: string }) {
  const body = (
    <>
      <LogoMark size={size} />
      <span className="logo-name">{name}</span>
    </>
  );
  return href ? <a className="logo" href={href} aria-label={name}>{body}</a> : <span className="logo">{body}</span>;
}
