import { describe, expect, test } from "vitest";
import { matchToolIdentity } from "./engine.ts";

/**
 * Property/fuzz harness for the policy tool-identity matcher — the trust boundary
 * an `allow` decision rides on. A passing example suite proves the cases the
 * author imagined; this explores the input space the author did NOT, with an
 * attacker's bias (smuggle the governed value everywhere BUT the governed field).
 *
 * No new dependency: a seeded PRNG (mulberry32) makes every run deterministic, so
 * a failure prints the exact seed+iteration to reproduce. The generator emits only
 * JSON-representable values — the real input domain, since a tool call's args
 * arrive as model-emitted JSON.
 *
 * The invariant under fire is SOUNDNESS OF THE FIELD-SCOPED ALLOW: `tool(F=G)`
 * fires only when the call's OWN top-level field `F` is a string matching glob `G`.
 * Nothing in another field, a nested copy of `F`, an array, a case-variant key, or
 * a JSON `__proto__` key may satisfy it — otherwise a disallowed value could be
 * smuggled past an allow rule (the exact fail-open the field-scoped form closed).
 */

// mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Deterministic given a
// seed (Math.random is banned here so failures always reproduce).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELD = "to";
const GLOB = "*@acme.test*"; // mirrors the real pdp rule mcp__mail__send(to=*@acme.test*)
const PATTERN = `mcp__mail__send(${FIELD}=${GLOB})`;
const TOOL = "mcp__mail__send";

// Strings that DO match GLOB (contain "@acme.test", case-insensitively) — the
// "forbidden allowed" values an attacker wants to slip past the allow.
const MATCHING = ["x@acme.test", "boss@ACME.test", "a@acme.testb", "@acme.test", "  @Acme.Test  "];
// Strings that do NOT match GLOB — safe to place as the governed field's own value.
const NON_MATCHING = ["", "x@evil.test", "acme.test", "@acme", "plain", "to", "@acme.tes", "acme@test"];

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

/**
 * A random JSON value with adversarial bias. `plantMatching` sprinkles GLOB-matching
 * strings into keys, nested objects, arrays — everywhere a smuggling attempt would
 * put them. Depth-bounded so the structural fuzz stays fast (a separate test drives
 * the deep-nesting totality path).
 */
function genValue(rng: () => number, depth: number, plantMatching: boolean): unknown {
  if (depth <= 0) {
    // leaf
    const r = rng();
    if (r < 0.35) return plantMatching && rng() < 0.5 ? pick(rng, MATCHING) : pick(rng, NON_MATCHING);
    if (r < 0.5) return Math.floor(rng() * 1e6);
    if (r < 0.6) return rng() < 0.5;
    if (r < 0.65) return null;
    return pick(rng, NON_MATCHING);
  }
  const r = rng();
  if (r < 0.45) return genObject(rng, depth - 1, plantMatching);
  if (r < 0.7) {
    const n = Math.floor(rng() * 4);
    return Array.from({ length: n }, () => genValue(rng, depth - 1, plantMatching));
  }
  return genValue(rng, 0, plantMatching);
}

function genObject(rng: () => number, depth: number, plantMatching: boolean): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 5);
  // Keys chosen to include smuggling traps: the governed name nested deeper, its
  // case variants, prototype-ish names, and arbitrary siblings.
  const KEYS = ["to", "To", "TO", "cc", "body", "subject", "constructor", "toString", "x", "nested", "value"];
  for (let i = 0; i < n; i++) {
    obj[pick(rng, KEYS)] = genValue(rng, depth, plantMatching);
  }
  return obj;
}

/**
 * Force the DIRECT own governed field to something that provably does NOT satisfy
 * GLOB (absent / non-string / non-matching string), so any match would have to
 * come from a smuggle. Returns the args object with that guarantee.
 */
function withSafeGovernedField(rng: () => number, base: Record<string, unknown>): Record<string, unknown> {
  const roll = rng();
  if (roll < 0.25) {
    delete base[FIELD]; // absent
  } else if (roll < 0.5) {
    base[FIELD] = Math.floor(rng() * 1000); // non-string
  } else if (roll < 0.6) {
    base[FIELD] = null;
  } else if (roll < 0.75) {
    base[FIELD] = { to: pick(rng, MATCHING) }; // nested matching, but own value is an OBJECT
  } else if (roll < 0.85) {
    base[FIELD] = [pick(rng, MATCHING)]; // array holding a matching string, own value is an ARRAY
  } else {
    base[FIELD] = pick(rng, NON_MATCHING); // a non-matching string
  }
  return base;
}

describe("field-scoped allow soundness (fuzz)", () => {
  for (const seed of [1, 42, 1337, 0xc0ffee, 987654321]) {
    test(`no smuggle: an allow field-scoped rule NEVER fires when the OWN governed field doesn't match (seed ${seed})`, () => {
      const rng = mulberry32(seed);
      for (let i = 0; i < 3000; i++) {
        const args = withSafeGovernedField(rng, genObject(rng, 4, /* plantMatching */ true));
        const fired = matchToolIdentity(PATTERN, TOOL, args);
        if (fired) {
          throw new Error(
            `SMUGGLE BYPASS at seed=${seed} iter=${i}: rule ${PATTERN} fired though args.${FIELD}=` +
              `${JSON.stringify(args[FIELD])} does not match. args=${JSON.stringify(args)}`,
          );
        }
      }
    });

    test(`capability holds: the rule DOES fire when the own governed field matches (seed ${seed})`, () => {
      const rng = mulberry32(seed ^ 0x5a5a);
      for (let i = 0; i < 1500; i++) {
        const args = genObject(rng, 3, /* plantMatching */ false);
        args[FIELD] = pick(rng, MATCHING); // own governed field genuinely matches
        expect(matchToolIdentity(PATTERN, TOOL, args)).toBe(true);
        // ...and a non-matching TOOL NAME must still refuse, matching field or not.
        expect(matchToolIdentity(PATTERN, "mcp__other__send", args)).toBe(false);
      }
    });
  }
});

describe("the fuzz has teeth: the smuggled value IS reachable, field-scoping is what stops it", () => {
  test("blob form fires on a sibling-field smuggle; field-scoped form refuses the same args", () => {
    // A matching value planted in `cc` (not the governed `to`). It is genuinely
    // present in the call — the blob (fail-open-for-allow) form proves it reaches
    // the matcher — yet the field-scoped form correctly does NOT fire.
    const args = { to: "safe@evil.test", cc: "attacker@acme.test", body: "hi" };
    expect(matchToolIdentity(`${TOOL}(*@acme.test*)`, TOOL, args)).toBe(true); // blob: reachable
    expect(matchToolIdentity(PATTERN, TOOL, args)).toBe(false); // field-scoped: refused
  });
});

describe("field-name access traps (deterministic)", () => {
  test("object keys are case-SENSITIVE even though the value glob is case-insensitive", () => {
    expect(matchToolIdentity(PATTERN, TOOL, { to: "x@acme.test" })).toBe(true);
    for (const k of ["To", "TO", "tO", "to "]) {
      expect(matchToolIdentity(PATTERN, TOOL, { [k]: "x@acme.test" })).toBe(false);
    }
  });

  test("a JSON `__proto__` own key cannot inject the governed field (bracket access is not fooled)", () => {
    const args = JSON.parse(String.raw`{"__proto__":{"to":"x@acme.test"},"cc":"noise"}`);
    expect(matchToolIdentity(PATTERN, TOOL, args)).toBe(false);
  });

  test("prototype method names as the governed field never match a plain object", () => {
    for (const field of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      const p = `${TOOL}(${field}=*)`;
      expect(matchToolIdentity(p, TOOL, { x: 1 })).toBe(false);
      expect(matchToolIdentity(p, TOOL, JSON.parse(String.raw`{"x":1}`))).toBe(false);
    }
  });

  test("args that are not a plain object never satisfy a field-scoped rule", () => {
    for (const args of [null, undefined, 42, "x@acme.test", true, [{ to: "x@acme.test" }]]) {
      expect(matchToolIdentity(PATTERN, TOOL, args)).toBe(false);
    }
  });
});

describe("matcher totality — never throws, always returns a boolean (fuzz)", () => {
  const PATTERNS = [PATTERN, `${TOOL}(*@acme.test*)`, "bash(*rm -rf*)", "read", "mcp__*__*"];
  test("wide random inputs, including deep nesting past the depth cap", () => {
    const rng = mulberry32(2024);
    for (let i = 0; i < 4000; i++) {
      const args = genValue(rng, 5, rng() < 0.5);
      for (const p of PATTERNS) {
        const tool = rng() < 0.5 ? TOOL : "bash";
        const out = matchToolIdentity(p, tool, args);
        expect(typeof out).toBe("boolean");
      }
    }
  });

  test("pathological nesting (3000 levels) is total — no stack overflow, no throw", () => {
    let deep: unknown = "x@acme.test";
    for (let i = 0; i < 3000; i++) deep = { nested: deep };
    // Both the field-scoped path and the blob path must return without throwing.
    expect(() => matchToolIdentity(PATTERN, TOOL, deep)).not.toThrow();
    expect(() => matchToolIdentity(`${TOOL}(*@acme.test*)`, TOOL, deep)).not.toThrow();
    expect(() => matchToolIdentity("bash(*x*)", "bash", deep)).not.toThrow();
  });
});

describe("blob-form deny/ask fail-SAFE surface (fuzz)", () => {
  test("a sensitive substring planted anywhere within the depth cap fires the blob rule", () => {
    const rng = mulberry32(7);
    const MARK = "SENSITIVE-XYZ";
    for (let i = 0; i < 1500; i++) {
      // Build a random object, then plant MARK at a random reachable position.
      const args = genObject(rng, 3, false);
      const trail: Record<string, unknown> = {};
      trail.mark = MARK;
      args[`k${i % 5}`] = rng() < 0.5 ? MARK : [{ deep: trail }];
      // Blob form over a non-bash tool: canonical arg string (all nested strings)
      // matched case-insensitively — the fail-SAFE surface for deny/ask.
      expect(matchToolIdentity(`${TOOL}(*sensitive-xyz*)`, TOOL, args)).toBe(true);
    }
  });
});
