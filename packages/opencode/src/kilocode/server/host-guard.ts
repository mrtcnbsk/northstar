// kilocode_change - new file: DNS-rebinding defense for the local server.
//
// A DNS-rebinding attack points a public domain (e.g. attacker.com) at 127.0.0.1 so a page the victim
// visits can issue same-"site" requests to the local server. The tell is the Host header: a legitimate
// local client always connects via loopback (localhost / 127.0.0.1 / ::1), an IP literal, a bare
// single-label hostname, or an mDNS *.local name — never a registrable multi-label public domain.
//
// `isRebinding` fails OPEN for every legitimate shape and returns true ONLY for a public-domain Host,
// so wiring it into request handling can only ever block the rebinding vector, never a real client.

export namespace HostGuard {
  /** True only when the Host header is a registrable multi-label public domain — the rebinding vector. */
  export function isRebinding(host: string | undefined): boolean {
    if (!host) return false
    // Strip a trailing :port (IPv4/hostname form). IPv6 literals are handled below.
    const name = host
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, "")
    if (name === "") return false
    // IPv6 literal (bracketed like [::1] or bare like ::1) — never a domain.
    if (name.startsWith("[") || name.includes(":")) return false
    // IPv4 literal (covers 127.0.0.1, 0.0.0.0, LAN IPs).
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false
    if (name === "localhost") return false
    // A bare single-label hostname (no dot) cannot be a public domain.
    if (!name.includes(".")) return false
    // mDNS / local suffixes are legitimate.
    if (name.endsWith(".local") || name.endsWith(".localhost")) return false
    // Anything left is a multi-label public-looking domain → treat as a rebinding attempt.
    return true
  }
}
