import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { applyRedactors, checkModel, compileRedactors, decideTool } from "@openharness/policy";
import type { CompiledRedactor, Policy } from "@openharness/policy";

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
 *   an error tool-result the model sees; the tool never runs). ask ⇒ ctx.ui.confirm
 *   when a dialog UI is available, else DENY (fail-closed for headless/desktop).
 *   allow ⇒ redact the args by mutating `event.input` IN PLACE (the same object
 *   the tool executes with), so secrets never reach the tool.
 * - `tool_result` — redact `content`/`details` before the result re-enters context.
 * - `before_provider_request` — defense-in-depth model-denial warning (cannot block).
 *
 * Redactors are compiled ONCE here (throwing on an invalid pattern so a broken
 * policy fails loud at wiring time) and reused on every hook — the `tool_result`
 * hook is wrapped in try/catch by Pi's runner, so a per-call compile that threw
 * would silently leak the secret. Compiling up-front removes that risk.
 */
export function buildPolicyExtension(
  policy: Policy,
  opts: PolicyExtensionOptions = {},
): InlineExtension {
  const redactors: CompiledRedactor[] = compileRedactors(policy);
  const log = opts.logger ?? ((m: string) => console.error(m));
  const providerId = opts.providerId;

  function redactInPlace(input: Record<string, unknown>): void {
    if (redactors.length === 0) return;
    const redacted = applyRedactors(redactors, input) as Record<string, unknown>;
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, redacted);
  }

  return {
    name: "openharness-policy",
    factory: (pi) => {
      pi.on("tool_call", async (event, ctx) => {
        const { decision, reason } = decideTool(policy, event.toolName, event.input);

        if (decision === "deny") {
          return { block: true, reason: reason ?? `Blocked by policy: tool "${event.toolName}" is denied.` };
        }

        if (decision === "ask") {
          let approved = false;
          if (ctx.hasUI) {
            try {
              approved = await ctx.ui.confirm("Policy approval", `Allow tool "${event.toolName}" to run?`);
            } catch {
              approved = false; // fail closed if the approval UI itself errors
            }
          }
          if (!approved) {
            return {
              block: true,
              reason:
                reason ??
                `Denied by policy: tool "${event.toolName}" requires interactive approval and none was granted.`,
            };
          }
        }

        // allow (or approved ask): redact args before the tool executes.
        redactInPlace(event.input as Record<string, unknown>);
        return undefined;
      });

      pi.on("tool_result", async (event) => {
        if (redactors.length === 0) return undefined;
        return {
          content: applyRedactors(redactors, event.content),
          details: applyRedactors(redactors, event.details),
        };
      });

      if (providerId && policy.models) {
        pi.on("before_provider_request", async (event, ctx) => {
          const payload = event.payload as { model?: unknown } | null | undefined;
          const model = typeof payload?.model === "string" ? payload.model : undefined;
          if (model && checkModel(policy, providerId, model) === "deny") {
            const message = `[openharness/policy] model "${providerId}/${model}" is denied by policy but cannot be blocked at the provider layer; the model gate is enforced at session creation.`;
            if (ctx.hasUI) ctx.ui.notify(message, "warning");
            else log(message);
          }
          return event.payload;
        });
      }
    },
  };
}
