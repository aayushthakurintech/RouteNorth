/**
 * Security headers for every page. Scripts and styles may run inline because Next.js needs that without a nonce set-up;
 * everything else is narrowed. Maps load tiles and fonts over https and run their workers from blob: addresses.
 * Only the public pages that are meant to be embedded on a customer's site (tracking, shared reports, bookings) may be
 * framed; the rest of the app may not.
 */
const dev = process.env.NODE_ENV !== "production";
// The API may be on another origin (and on plain http when run locally), so name it, and its live-update socket, exactly.
const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000");
const apiOrigins = `${api.origin} ${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
const csp = (frame) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  `connect-src 'self' ${apiOrigins} https: wss:${dev ? " http: ws:" : ""}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${frame}`,
].join("; ");
const common = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=()" },
  ...(dev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];
// Pages meant to be embedded on a customer's site: live tracking, shared reports, booking, job links, status pages.
const EMBEDDABLE = "track|shared|book|j|status";

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@routenorth/shared"],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: `/((?!(?:${EMBEDDABLE})(?:/|$)).*)`, headers: [...common, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: csp("'none'") }] },
      { source: `/:section(${EMBEDDABLE})/:path*`, headers: [...common, { key: "Content-Security-Policy", value: csp("*") }] },
    ];
  },
};
