/**
 * Per-connector egress control + a forward-proxy "tap". Every upstream request a
 * connector makes goes through here: the destination must be on the connector's
 * host allowlist over TLS (blocking SSRF to private ranges), and the outbound
 * body is inspected for fields the sanctioned args never contained — the
 * Postmark-MCP defense (a BCC the user never set is added by the upstream lib
 * AFTER the gateway handed it clean args, and is visible/blockable here).
 */

/** Is this hostname a private / link-local / loopback / internal target? */
export function isPrivateHost(host: string): boolean {
  // WHATWG `URL.hostname` keeps brackets around IPv6 literals — strip them so the
  // IPv6 checks below actually see `::1` / `fc00::1` rather than `[::1]`.
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local"))
    return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback / ULA
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`): re-check the embedded IPv4 literal.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateHost(mapped[1]);
  // IPv4 literals in private / loopback / link-local ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Whether `url` is an allowed upstream for a connector limited to `allowHosts`. */
export function egressAllowed(allowHosts: string[], url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // TLS only
  if (isPrivateHost(u.hostname)) return false; // SSRF guard
  return allowHosts.includes(u.hostname);
}

/**
 * The forward-proxy tap: assert an outbound request body carries no field the
 * sanctioned args didn't authorize. Returns the first injected field path, or
 * undefined when clean. Compares recursively; only string/number/bool/null leaf
 * ADDITIONS are flagged (a value change to a sanctioned field is allowed —
 * connectors legitimately transform values; a NEW field is the Postmark signal).
 */
export function tapInjectedField(
  outboundBody: unknown,
  sanctionedArgs: unknown,
  path = "",
): string | undefined {
  if (outboundBody === null || typeof outboundBody !== "object") return undefined;
  if (Array.isArray(outboundBody)) {
    const s = Array.isArray(sanctionedArgs) ? sanctionedArgs : [];
    for (let i = 0; i < outboundBody.length; i++) {
      // An element beyond the sanctioned array's length was never authorized —
      // flag it whether it is a scalar (a smuggled extra recipient) or an object.
      if (i >= s.length) return `${path}[${i}]`;
      const hit = tapInjectedField(outboundBody[i], s[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  const s = (sanctionedArgs !== null && typeof sanctionedArgs === "object" ? sanctionedArgs : {}) as Record<
    string,
    unknown
  >;
  for (const [k, v] of Object.entries(outboundBody as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    // `Object.hasOwn`, NOT `k in s`: `in` walks the prototype chain, so an
    // injected key named like an Object.prototype member (`constructor`,
    // `toString`, `__proto__`, …) would otherwise be treated as sanctioned.
    if (!Object.hasOwn(s, k)) return here; // a field the sanctioned args never had
    if (v !== null && typeof v === "object") {
      const hit = tapInjectedField(v, s[k], here);
      if (hit) return hit;
    }
  }
  return undefined;
}
