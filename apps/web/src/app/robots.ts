import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/** Search engines may read the public pages only; the signed-in app and tokenised links stay out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/terms", "/privacy", "/accessibility", "/security", "/status"], disallow: ["/live", "/owner", "/portal", "/driver", "/reset", "/invite", "/track", "/j", "/book"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
