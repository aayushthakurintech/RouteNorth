/** True when `ip` matches an entry of the list: an exact address or an IPv4 CIDR range. */
export function ipAllowed(ip: string, list: string[]): boolean {
  const addr = ip.replace(/^::ffff:/, "");
  const toInt = (a: string) => a.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  return list.some((entry) => {
    if (entry === addr) return true;
    const [base, bits] = entry.split("/");
    if (!bits || !v4.test(base!) || !v4.test(addr)) return false;
    const n = Number(bits);
    if (!(n >= 0 && n <= 32)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (toInt(addr) & mask) === (toInt(base!) & mask);
  });
}
