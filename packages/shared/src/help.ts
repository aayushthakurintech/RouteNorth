/** The help center's articles. Titles and bodies are in the message files as hlp_<id>_t and hlp_<id>_b. */
export const HELP_TOPICS = ["basics", "fleet", "dispatch", "customers", "money", "team", "security"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export interface HelpArticle { id: string; topic: HelpTopic; href: string }

export const HELP_ARTICLES: readonly HelpArticle[] = [
  { id: "start", topic: "basics", href: "/" },
  { id: "language", topic: "basics", href: "/settings/profile" },
  { id: "vehicles", topic: "fleet", href: "/fleet/vehicles" },
  { id: "drivers", topic: "fleet", href: "/drivers" },
  { id: "nodata", topic: "fleet", href: "/settings/health" },
  { id: "routes", topic: "dispatch", href: "/routes" },
  { id: "dispatch", topic: "dispatch", href: "/dispatch" },
  { id: "import", topic: "dispatch", href: "/import" },
  { id: "driverapp", topic: "dispatch", href: "/driver" },
  { id: "tracking", topic: "customers", href: "/settings/customers" },
  { id: "alerts", topic: "customers", href: "/alerts" },
  { id: "invoices", topic: "money", href: "/billing" },
  { id: "tax", topic: "money", href: "/billing" },
  { id: "reports", topic: "money", href: "/reports" },
  { id: "invite", topic: "team", href: "/settings/teams" },
  { id: "roles", topic: "team", href: "/settings/users" },
  { id: "twofactor", topic: "security", href: "/settings/security" },
  { id: "privacy", topic: "security", href: "/settings/security" },
  { id: "api", topic: "security", href: "/integrations" },
];

/** A rough relevance score for a search: whole-word and title hits count more than hits in the body. */
export function scoreArticle(text: { title: string; body: string }, query: string): number {
  const words = query.toLowerCase().split(/\s+/).map((w) => w.normalize("NFD").replace(/[̀-ͯ]/g, "")).filter(Boolean);
  if (!words.length) return 1;
  const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const title = fold(text.title), body = fold(text.body);
  let score = 0;
  for (const w of words) {
    const t = title.includes(w), b = body.includes(w);
    if (!t && !b) return 0; // every word must appear somewhere
    score += (t ? 3 : 0) + (b ? 1 : 0) + (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title) ? 2 : 0);
  }
  return score;
}
