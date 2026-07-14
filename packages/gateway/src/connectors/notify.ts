import { egressAllowed, tapInjectedField } from "../egress.ts";
import type { Connector, ConnectorResult } from "./index.ts";

const DEFAULT_HOST = "api.postmarkapp.com";

export interface NotifyConnectorOptions {
  fetchImpl?: typeof fetch;
  /** Allowlisted host the notify endpoint lives on (TLS-only, SSRF-guarded). */
  host?: string;
  /**
   * Fields a client template merges into every outbound request — exactly the
   * Postmark injection vector. If a poisoned template adds a field the sanctioned
   * args never had (a silent BCC), the forward-proxy tap catches it before egress
   * and the send is REFUSED. Empty by default (clean).
   */
  defaults?: Record<string, unknown>;
}

/**
 * A WRITE connector (send a notification), first-party so there is no
 * auto-updating third-party layer to be rug-pulled. It is the connector that
 * actually exercises the forward-proxy tap: the body it is about to POST is
 * compared against the sanctioned args, and any unsanctioned field on the wire
 * (the Postmark-class BCC) blocks the send. The org credential is handed in at
 * call time and never held on the connector.
 */
export function createNotifyConnector(options: NotifyConnectorOptions = {}): Connector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = options.host ?? DEFAULT_HOST;
  const defaults = options.defaults ?? {};
  const allowHosts = [host];
  const url = `https://${host}/notify`;

  return {
    id: "notify",
    tools: [{ name: "notify__send", description: "Send a notification to the configured upstream." }],
    allowHosts,
    async call(_toolName, args, cred): Promise<ConnectorResult> {
      if (!egressAllowed(allowHosts, url)) {
        return { content: [{ type: "text", text: "egress blocked: not an allowed upstream" }], isError: true };
      }
      // The body actually going on the wire: template defaults FIRST, then the
      // sanctioned args — so a poisoned template can never OVERRIDE a sanctioned
      // field's value (e.g. silently redirect the recipient); it can only add
      // fields, which the tap then catches as unsanctioned.
      const outbound = { ...defaults, ...args };
      const injected = tapInjectedField(outbound, args);
      if (injected) {
        return {
          content: [
            {
              type: "text",
              text: `blocked before egress: outbound request carries an unsanctioned field '${injected}' (possible BCC/exfiltration injection)`,
            },
          ],
          isError: true,
        };
      }
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cred.secret}` },
        body: JSON.stringify(outbound),
      });
      if (!res.ok) return { content: [{ type: "text", text: `notify failed: HTTP ${res.status}` }], isError: true };
      return { content: [{ type: "text", text: "sent" }] };
    },
  };
}
