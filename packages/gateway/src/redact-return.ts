import { applyRedactors, compileRedactors } from "@openharness/policy";
import type { Policy } from "@openharness/policy";
import type { ConnectorResult } from "./connectors/index.ts";

/** Default per-text-block cap. Oversized upstream responses are truncated. */
const DEFAULT_MAX_CHARS = 200_000;

/**
 * Sanitize a connector result on the RETURN path, before it reaches the client
 * (and, downstream, the model's context): apply the policy's secret redactors to
 * every text block and cap oversized blocks. Reuses `@openharness/policy`'s
 * compiled redactors — the same rules the local enforcement uses — so a secret
 * an upstream echoes back never re-enters context.
 */
export function sanitizeResult(
  policy: Policy,
  result: ConnectorResult,
  maxChars: number = DEFAULT_MAX_CHARS,
): ConnectorResult {
  const redactors = compileRedactors(policy);
  const content = result.content.map((c) => {
    let text = redactors.length ? applyRedactors(redactors, c.text) : c.text;
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
    }
    return { ...c, text };
  });
  return { ...result, content };
}
