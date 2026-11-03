/** Helpers for Canadian street addresses: spot common problems and suggest a cleaner form before geocoding. */

const PROVINCES: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB", "newfoundland and labrador": "NL", newfoundland: "NL",
  "nova scotia": "NS", ontario: "ON", "prince edward island": "PE", quebec: "QC", québec: "QC", saskatchewan: "SK",
  "northwest territories": "NT", nunavut: "NU", yukon: "YT",
  ont: "ON", que: "QC", "p.q.": "QC", alta: "AB", sask: "SK", man: "MB", "b.c.": "BC", "n.s.": "NS", "n.b.": "NB", "n.l.": "NL", "p.e.i.": "PE",
};
const CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const POSTAL = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;
const SUFFIX: Record<string, string> = {
  st: "St", street: "St", ave: "Ave", avenue: "Ave", rd: "Rd", road: "Rd", blvd: "Blvd", boulevard: "Blvd", dr: "Dr", drive: "Dr", ln: "Ln", lane: "Ln",
  ct: "Ct", court: "Ct", cres: "Cres", crescent: "Cres", hwy: "Hwy", highway: "Hwy", pkwy: "Pkwy", parkway: "Pkwy", pl: "Pl", place: "Pl", way: "Way", ter: "Terr", terrace: "Terr",
  rue: "rue", ch: "ch", boul: "boul",
};

export type AddressIssue = "empty" | "no_street_number" | "no_postal_code" | "no_province" | "odd_postal_code" | "all_caps" | "too_short";

export interface AddressCheck {
  /** A tidier version of the address: spacing, capitals, province code, postal code format. */
  suggestion: string;
  issues: AddressIssue[];
  postalCode: string | null;
  province: string | null;
}

const titleWord = (w: string) => (w.length <= 2 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

export function checkAddress(raw: string): AddressCheck {
  const issues: AddressIssue[] = [];
  let s = raw.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  if (!s) return { suggestion: "", issues: ["empty"], postalCode: null, province: null };
  if (s.length < 6) issues.push("too_short");
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length > 8 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.8) issues.push("all_caps");

  let postalCode: string | null = null;
  const pm = POSTAL.exec(s);
  if (pm) {
    postalCode = `${pm[1]!.toUpperCase()} ${pm[2]!.toUpperCase()}`;
    s = s.replace(POSTAL, postalCode);
  } else {
    issues.push("no_postal_code");
    if (/\b[A-Z]\d[A-Z]\s?\d?\b/i.test(s)) issues.push("odd_postal_code");
  }

  // Province: a full name or a short form becomes the two-letter code.
  let province: string | null = null;
  const lower = s.toLowerCase();
  for (const [name, code] of Object.entries(PROVINCES).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(^|[ ,])${name.replace(/\./g, "\\.")}(?=$|[ ,])`, "i");
    if (re.test(lower)) { province = code; s = s.replace(new RegExp(`(^|[ ,])${name.replace(/\./g, "\\.")}(?=$|[ ,])`, "i"), `$1${code}`); break; }
  }
  if (!province) {
    const m = /(?:^|[ ,])(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)(?=$|[ ,])/.exec(s.toUpperCase());
    if (m && CODES.has(m[1]!)) province = m[1]!;
  }
  if (!province) issues.push("no_province");
  if (!/^\d+[A-Za-z]?\b|^\d+-\d+\b|\b\d+\s+(rue|chemin|boulevard|avenue)\b/i.test(s) && !/^[A-Z]?\d/.test(s)) issues.push("no_street_number");

  if (issues.includes("all_caps")) {
    s = s.split(" ").map((w) => (CODES.has(w.replace(/,/g, "")) || /\d/.test(w) ? w : titleWord(w))).join(" ");
  }
  // Street type words: "Street" -> "St" (English only; French types are left alone).
  s = s.replace(/\b([A-Za-z]+)\b(?=,|$| [A-Z]{2}\b)/g, (m, w: string) => (SUFFIX[w.toLowerCase()] && !/^(rue|ch|boul)$/i.test(w) ? SUFFIX[w.toLowerCase()]! : m));
  return { suggestion: s, issues, postalCode, province };
}
