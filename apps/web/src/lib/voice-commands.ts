/**
 * Hands-free commands for the driver app. The browser turns speech into text; this decides what the text means.
 * It knows English and French and ignores anything it is not sure about, so a wrong guess never changes a stop by itself:
 * the app always asks the driver to confirm.
 */
export type VoiceAction = "arrive" | "complete" | "fail" | "navigate" | "help" | "break_start" | "break_end" | "shift_end" | "message";
export interface VoiceCommand { action: VoiceAction; text?: string }

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

const RULES: { action: VoiceAction; re: RegExp }[] = [
  { action: "break_end", re: /\b(end|finish|stop|back from)( my)? (break|lunch)\b|\b(fin|termine|fini)( de)?( la| ma| mon)? (pause|diner|lunch)\b|\bretour de pause\b/ },
  { action: "break_start", re: /\b(start|begin|take)( my| a)? (break|lunch)\b|\b(debut|commence|prendre)( de)?( la| ma| mon| une)? (pause|diner|lunch)\b|\bje prends ma pause\b/ },
  { action: "shift_end", re: /\bend( my)? (shift|day)\b|\b(fin|termine)( de)?( mon| ma| la)? (quart|journee)\b/ },
  { action: "help", re: /\b(i need help|need help|help me|call dispatch|emergency)\b|\bj'ai besoin d'aide\b|\bau secours\b|\bbesoin d'aide\b|\burgence\b/ },
  { action: "fail", re: /\b(cant|can't|cannot|could not) deliver\b|\bnobody (is )?home\b|\bpersonne (est )?(a la maison|sur place)\b|\bimpossible de livrer\b/ },
  { action: "complete", re: /\b(delivered|complete(d)?( stop)?|mark( it)? done|stop done|done)\b|\blivre\b|\btermine l'arret\b|\barret termine\b|\bc'est fait\b/ },
  { action: "arrive", re: /\b(i'?m here|i have arrived|i arrived|arrived|at the stop)\b|\bje suis (la|arrive|arrivee)\b|\bjarrive\b|\bj'y suis\b|\bsur place\b/ },
  { action: "navigate", re: /\b(navigate|directions|next stop|take me|go to the next)\b|\b(navigation|itineraire|prochain arret|guide moi|emmene moi)\b/ },
];

/** What the driver asked for, or null when it is not clearly one of the known commands. */
export function parseVoiceCommand(raw: string): VoiceCommand | null {
  const s = norm(raw);
  if (!s || s.length > 200) return null;
  const msg = /^(message|tell dispatch|text dispatch|dis a la repartition|dites a la repartition|message a la repartition)\s+(.{2,})$/.exec(s);
  if (msg) return { action: "message", text: raw.trim().replace(/^\S+(\s+(dispatch|a la repartition|à la répartition))?\s*/i, "").trim() || msg[2] };
  for (const r of RULES) if (r.re.test(s)) return { action: r.action };
  return null;
}
