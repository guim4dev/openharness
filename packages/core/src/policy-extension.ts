import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { applyRedactors, checkModel, compileRedactors, decideTool, matchToolIdentity } from "@openharness/policy";
import type { CompiledRedactor, Policy } from "@openharness/policy";
import { hashCanonical } from "@openharness/audit";
import type { AuditSink, ToolDecision } from "@openharness/audit";

export interface PolicyExtensionOptions {
  /**
   * Provider id the session resolves against (e.g. "anthropic"). When set AND
   * the policy has a `models` section, a `before_provider_request` guard logs a
   * warning if a denied model is used mid-session (the provider layer cannot
   * block — the authoritative model gate is enforced at session creation).
   */
  providerId?: string;
  /** Where the model-denial warning goes. Default: console.error. */
  logger?: (message: string) => void;
  /**
   * Optional audit sink. When present, every tool decision, tool result, and
   * provider request is recorded as an external-call event. The audit log NEVER
   * carries raw args, results, or prompt/message content — only fingerprints
   * (SHA-256 over redacted payloads) and non-sensitive metadata.
   */
  audit?: AuditSink;
  /**
   * Out-of-band approval resolver for `ask` decisions. When provided it takes
   * precedence over the in-process `ctx.ui.confirm` path: the desktop sidecar
   * wires this to pop an approve/deny dialog in the React UI over the loopback
   * WS and resolves the tool call with the user's answer.
   *
   * Fail-closed: a rejected promise (or a thrown error) is treated as a DENY,
   * and the resolver itself is responsible for denying when no human can be
   * reached (no client, timeout, socket closed). When omitted, the legacy
   * behavior is unchanged — `ctx.ui.confirm` if a dialog UI exists, else DENY.
   */
  askUser?: (req: { toolName: string; reason?: string }) => Promise<boolean>;
}

/** Placeholder that replaces tool_result content when redaction compute fails closed. */
const REDACTION_ERROR_TEXT = "[result withheld: redaction error]";
const WITHHELD_CONTENT: { type: "text"; text: string }[] = [{ type: "text", text: REDACTION_ERROR_TEXT }];

/** Fingerprint for an audit entry whose real payload could not be safely computed. */
function withheldHash(toolName: string): string {
  return hashCanonical({ withheld: true, tool: toolName });
}

/** `mcp__<server>__<tool>` -> `<server>`; undefined for non-MCP tools. */
function parseMcpServer(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const rest = toolName.slice("mcp__".length);
  const idx = rest.indexOf("__");
  return idx > 0 ? rest.slice(0, idx) : undefined;
}

/** The `match` pattern of the first rule that matches, or undefined (default decided). */
function matchedRuleId(policy: Policy, toolName: string, args: unknown): string | undefined {
  for (const rule of policy.rules) {
    if (matchToolIdentity(rule.match, toolName, args)) return rule.match;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the in-process Pi enforcement extension for a policy.
 *
 * Registration mechanism (pi-coding-agent@0.80.6): returned as an
 * `InlineExtension` and passed via `resourceLoaderOptions.extensionFactories`.
 * The resource loader loads inline factories on EVERY path (including
 * `noExtensions: true`, which only filters file-discovered extensions), so
 * enforcement is always active once wired.
 *
 * Hooks:
 * - `tool_call`  — deny ⇒ `{ block: true, reason }` (agent-loop turns this into
 *   an error tool-result the model sees; the tool never runs). ask ⇒ the
 *   out-of-band `askUser` resolver when one is wired (the desktop's WS dialog),
 *   else `ctx.ui.confirm` when a dialog UI is available, else DENY (fail-closed
 *   for headless with no resolver). allow ⇒ redact the args by mutating
 *   `event.input` IN PLACE (the same object the tool executes with), so secrets
 *   never reach the tool.
 * - `tool_result` — redact `content`/`details` before the result re-enters context.
 * - `before_provider_request` — defense-in-depth model-denial warning (cannot block).
 *
 * Redactors are compiled ONCE here (throwing on an invalid pattern so a broken
 * policy fails loud at wiring time) and reused on every hook — the `tool_result`
 * hook is wrapped in try/catch by Pi's runner, so a per-call compile that threw
 * would silently leak the secret. Compiling up-front removes that risk.
 *
 * FAIL-CLOSED ON REDACTION COMPUTE FAILURE: `applyRedactors`/`hashCanonical` can
 * still throw at call time on pathological content they were never handed a
 * chance to reject up front — a circular reference (stack overflow walking the
 * object graph) or a non-JSON-serializable value (e.g. a BigInt). Pi's runner
 * treats a throwing hook as "no result" — for `tool_call` that means the tool
 * would run with the ORIGINAL, unredacted args; for `tool_result` the ORIGINAL,
 * unredacted output would re-enter model context. Both hooks therefore wrap
 * their redaction+hash compute in try/catch and fail closed on throw: `tool_call`
 * blocks the call (`{ block: true, reason }`), `tool_result` replaces the
 * content with a withheld placeholder (`isError: true`) instead of forwarding
 * whatever was computed so far.
 */
export function buildPolicyExtension(
  policy: Policy,
  opts: PolicyExtensionOptions = {},
): InlineExtension {
  const redactors: CompiledRedactor[] = compileRedactors(policy);
  const log = opts.logger ?? ((m: string) => console.error(m));
  const providerId = opts.providerId;
  const audit = opts.audit;
  const askUser = opts.askUser;

  function redactInPlace(input: Record<string, unknown>): void {
    if (redactors.length === 0) return;
    const redacted = applyRedactors(redactors, input) as Record<string, unknown>;
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, redacted);
  }

  /**
   * Record to the audit sink WITHOUT ever letting a sink failure abort the hook.
   * Pi's runner wraps each hook in try/catch, so a throw from `record()`
   * (ENOSPC/EIO/closed fd) would skip the hook's return — and the hook's return
   * is what applies the block / redaction. Swallowing here keeps the security
   * outcome (block, redact) authoritative and independent of audit durability.
   */
  function safeRecord(entry: Parameters<AuditSink["record"]>[0]): void {
    if (!audit) return;
    try {
      const r = audit.record(entry);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e: unknown) => log(`[openharness/policy] audit record failed: ${String(e)}`));
      }
    } catch (e) {
      log(`[openharness/policy] audit record failed: ${String(e)}`);
    }
  }

  return {
    name: "openharness-policy",
    factory: (pi) => {
      pi.on("tool_call", async (event, ctx) => {
        // Decision + rule-id are derived from attacker-influenced `event.input`
        // and WALK it (parameterized rules match against a canonical arg string),
        // so they can throw on pathological input. Compute them fail-CLOSED: a
        // throw here would otherwise abort the hook before any `return`, and Pi's
        // runner treats a throwing hook as "no result" — the tool would run
        // UNBLOCKED and unredacted. Any throw therefore forces a deny.
        let decision: "allow" | "deny" | "ask" = "deny";
        let reason: string | undefined;
        let ruleId: string | undefined;
        let decisionComputeFailed = false;
        try {
          const evaluated = decideTool(policy, event.toolName, event.input);
          decision = evaluated.decision;
          reason = evaluated.reason;
          ruleId = matchedRuleId(policy, event.toolName, event.input);
        } catch (e) {
          decisionComputeFailed = true;
          log(
            `[openharness/policy] policy decision compute failed for tool_call "${event.toolName}", failing closed: ${String(e)}`,
          );
        }

        // Fingerprint the REDACTED args (never the raw args) so a secret in an
        // argument can never be recovered from the audit log — recorded even for
        // denials, which block before the tool ever runs. Computed defensively:
        // `applyRedactors`/`hashCanonical` can throw on pathological `event.input`
        // (circular refs, non-JSON-serializable values); a throw fails closed.
        const server = parseMcpServer(event.toolName);
        let argsHash: string;
        let redactionComputeFailed = false;
        try {
          argsHash = hashCanonical(redactors.length ? applyRedactors(redactors, event.input) : event.input);
        } catch (e) {
          redactionComputeFailed = true;
          argsHash = withheldHash(event.toolName);
          log(
            `[openharness/policy] redaction/hash compute failed for tool_call "${event.toolName}", failing closed: ${String(e)}`,
          );
        }
        const recordDecision = (auditDecision: ToolDecision): void => {
          safeRecord({
            type: "tool_call",
            tool: event.toolName,
            ...(server ? { server } : {}),
            decision: auditDecision,
            ...(ruleId ? { ruleId } : {}),
            argsHash,
          });
        };

        if (decisionComputeFailed) {
          recordDecision("deny");
          return {
            block: true,
            reason: `Blocked by policy: evaluating tool "${event.toolName}" against the policy failed (e.g. pathological arguments); failing closed.`,
          };
        }

        if (redactionComputeFailed) {
          recordDecision("deny");
          return {
            block: true,
            reason: `Blocked by policy: redaction of arguments for tool "${event.toolName}" failed; failing closed rather than risk leaking unredacted content.`,
          };
        }

        if (decision === "deny") {
          recordDecision("deny");
          return { block: true, reason: reason ?? `Blocked by policy: tool "${event.toolName}" is denied.` };
        }

        // Redact args in place, but fail closed if the compute itself throws.
        // `argsHash` above already proved `applyRedactors` succeeds on this same
        // `event.input`, so this is defense-in-depth rather than the expected
        // path — but it keeps the same guarantee even if that invariant ever
        // breaks (e.g. a future stateful redactor).
        const redactOrBlock = (): { block: true; reason: string } | undefined => {
          try {
            redactInPlace(event.input as Record<string, unknown>);
            return undefined;
          } catch (e) {
            log(
              `[openharness/policy] redaction compute failed mutating tool_call args for "${event.toolName}", failing closed: ${String(e)}`,
            );
            return {
              block: true,
              reason: `Blocked by policy: redaction of arguments for tool "${event.toolName}" failed; failing closed rather than risk leaking unredacted content.`,
            };
          }
        };

        if (decision === "ask") {
          let approved = false;
          if (askUser) {
            // Out-of-band approval (e.g. the desktop's WS dialog). Any rejection
            // is a DENY — fail-closed if the resolver itself errors.
            try {
              approved = await askUser({ toolName: event.toolName, ...(reason ? { reason } : {}) });
            } catch {
              approved = false;
            }
          } else if (ctx.hasUI) {
            try {
              approved = await ctx.ui.confirm("Policy approval", `Allow tool "${event.toolName}" to run?`);
            } catch {
              approved = false; // fail closed if the approval UI itself errors
            }
          }
          if (!approved) {
            recordDecision("ask-denied");
            return {
              block: true,
              reason:
                reason ??
                `Denied by policy: tool "${event.toolName}" requires interactive approval and none was granted.`,
            };
          }
          // approved ask: redact args before the tool executes, then record.
          const blocked = redactOrBlock();
          if (blocked) {
            recordDecision("deny");
            return blocked;
          }
          recordDecision("ask-approved");
          return undefined;
        }

        // allow: redact args before the tool executes, then record.
        const blocked = redactOrBlock();
        if (blocked) {
          recordDecision("deny");
          return blocked;
        }
        recordDecision("allow");
        return undefined;
      });

      pi.on("tool_result", async (event) => {
        const hasRedactors = redactors.length > 0;

        // Compute redaction + the audit fingerprint together, defensively, ALL
        // inside one try: `applyRedactors`/`hashCanonical` can throw on
        // pathological content (circular refs, non-JSON-serializable values).
        // If that throw escaped, it would abort this hook BEFORE the redacted
        // `return` below — Pi's runner treats a throwing hook as "no result",
        // i.e. the ORIGINAL, unredacted content would re-enter model context
        // (fail-open). Fail closed instead: withhold the result entirely.
        try {
          const content = hasRedactors ? applyRedactors(redactors, event.content) : event.content;
          const details = hasRedactors ? applyRedactors(redactors, event.details) : event.details;

          // Record through safeRecord so a throwing sink can never skip the
          // redacted return below — otherwise the ORIGINAL unredacted output
          // would re-enter model context (fail-open). The redacted return is
          // computed above and applied unconditionally.
          if (audit) {
            const changed =
              hasRedactors &&
              (hashCanonical(event.content) !== hashCanonical(content) ||
                hashCanonical(event.details) !== hashCanonical(details));
            // Fingerprint the REDACTED result — never the raw content/details.
            safeRecord({
              type: "tool_result",
              tool: event.toolName,
              redacted: changed,
              resultHash: hashCanonical({ content, details }),
            });
          }

          if (!hasRedactors) return undefined;
          return { content, details };
        } catch (e) {
          log(
            `[openharness/policy] redaction/hash compute failed on tool_result for "${event.toolName}", failing closed: ${String(e)}`,
          );
          // Record through safeRecord so a throwing sink can never skip the
          // withheld return below.
          safeRecord({
            type: "tool_result",
            tool: event.toolName,
            redacted: true,
            resultHash: withheldHash(event.toolName),
          });
          return { content: WITHHELD_CONTENT, isError: true };
        }
      });

      // A `before_provider_request` handler is needed when either the audit sink
      // wants a model_request record OR the model-denial warning is armed.
      if (audit || (providerId && policy.models)) {
        pi.on("before_provider_request", async (event, ctx) => {
          const payload = event.payload as
            | { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } }
            | null
            | undefined;
          const model = typeof payload?.model === "string" ? payload.model : undefined;

          if (providerId && policy.models && model && checkModel(policy, providerId, model) === "deny") {
            const message = `[openharness/policy] model "${providerId}/${model}" is denied by policy but cannot be blocked at the provider layer; the model gate is enforced at session creation.`;
            if (ctx.hasUI) ctx.ui.notify(message, "warning");
            else log(message);
          }

          if (audit) {
            // Record ONLY provider/model + token counts — never the payload's
            // messages/prompt content. safeRecord so a broken sink never aborts
            // the request payload return below.
            const tokensIn = finiteNumber(payload?.usage?.input_tokens);
            const tokensOut = finiteNumber(payload?.usage?.output_tokens);
            safeRecord({
              type: "model_request",
              provider: providerId ?? "unknown",
              model: model ?? "unknown",
              ...(tokensIn !== undefined ? { tokensIn } : {}),
              ...(tokensOut !== undefined ? { tokensOut } : {}),
            });
          }

          return event.payload;
        });
      }
    },
  };
}
