import { expect, test } from "vitest";
import { egressAllowed, isPrivateHost, tapInjectedField } from "./egress.ts";

test("egress allows an allowlisted https host", () => {
  expect(egressAllowed(["api.github.com"], "https://api.github.com/repos/o/r/issues")).toBe(true);
});

test("egress blocks a non-allowlisted host", () => {
  expect(egressAllowed(["api.github.com"], "https://evil.com/x")).toBe(false);
});

test("egress blocks non-TLS (http)", () => {
  expect(egressAllowed(["api.github.com"], "http://api.github.com/x")).toBe(false);
});

test("egress blocks private / loopback / link-local / internal hosts (SSRF guard)", () => {
  for (const h of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "192.168.0.1", "172.16.0.1", "localhost", "db.internal"]) {
    expect(isPrivateHost(h), h).toBe(true);
    expect(egressAllowed([h], `https://${h}/x`), h).toBe(false);
  }
  expect(isPrivateHost("api.github.com")).toBe(false);
});

test("SSRF guard covers bracketed / mapped IPv6 loopback + ULA (no bracket-evasion)", () => {
  // WHATWG hostname keeps brackets; the guard must still catch these.
  for (const h of ["[::1]", "[fc00::1]", "[fd12:3456::1]", "::1", "::ffff:127.0.0.1", "[::ffff:10.0.0.1]"]) {
    expect(isPrivateHost(h), h).toBe(true);
    expect(egressAllowed([h], `https://${h}/notify`), h).toBe(false);
  }
});

test("proxy tap: a body whose fields are a subset of the sanctioned args passes", () => {
  expect(tapInjectedField({ to: "a@x.com", subject: "hi" }, { to: "a@x.com", subject: "hi", body: "..." })).toBeUndefined();
});

test("proxy tap: an injected field not in the sanctioned args is flagged (Postmark BCC)", () => {
  expect(tapInjectedField({ to: "a@x.com", bcc: "attacker@evil.com" }, { to: "a@x.com" })).toBe("bcc");
});

test("proxy tap: a nested injected field is flagged with its path", () => {
  expect(tapInjectedField({ opts: { silent: true } }, { opts: {} })).toBe("opts.silent");
});

test("proxy tap: an extra ARRAY element (scalar) beyond the sanctioned length is flagged", () => {
  // The array-injection bypass: a smuggled extra recipient must not slip through.
  expect(tapInjectedField({ to: ["a@x.com", "attacker@evil.com"] }, { to: ["a@x.com"] })).toBe("to[1]");
  // A subset-length array is fine.
  expect(tapInjectedField({ to: ["a@x.com"] }, { to: ["a@x.com", "b@x.com"] })).toBeUndefined();
});

test("proxy tap: a prototype-named injected key is flagged (no `in`-chain evasion)", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    expect(tapInjectedField({ [key]: "EXFIL" }, { to: "a@x.com" }), key).toBe(key);
  }
});
