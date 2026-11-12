/** Optional AI service (Anthropic Messages API). Everything else in the app works without it; with it, the assistant understands free wording and photos of notes and receipts can be read. */
export const aiConfigured = (): boolean => !!process.env.ANTHROPIC_API_KEY;

export async function aiAsk(fetchImpl: typeof fetch, content: unknown[], maxTokens = 800): Promise<string> {
  const res = await fetchImpl(process.env.AI_API_URL ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.AI_MODEL ?? "claude-sonnet-5-5", max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AI service answered ${res.status}`);
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/** The first JSON object in a model's reply. */
export function extractJson(text: string): unknown {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
