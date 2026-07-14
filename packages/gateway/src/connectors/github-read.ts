import { normalizeCatalog } from "../catalog.ts";
import { egressAllowed } from "../egress.ts";
import type { UpstreamCredential } from "../broker.ts";
import type { Connector, ConnectorResult } from "./index.ts";

const HOST = "api.github.com";

/**
 * A first-party GitHub **read** connector — proof of the connector shape without
 * a third-party wrapper. Calls the GitHub REST API directly with the gateway's
 * own token (bearer), egress-gated to `api.github.com` over TLS. Read-only: no
 * mutation, so nothing here can write on the org's behalf. `fetchImpl` is
 * injectable for hermetic tests.
 */
export function createGithubReadConnector(fetchImpl: typeof fetch = fetch): Connector {
  const allowHosts = [HOST];
  const tools = normalizeCatalog([
    {
      name: "github__list_issues",
      description: "List issues in a repo (read-only).",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
    {
      name: "github__get_issue",
      description: "Get one issue by number (read-only).",
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } },
        required: ["owner", "repo", "number"],
      },
    },
  ]);

  async function get(url: string, cred: UpstreamCredential): Promise<ConnectorResult> {
    if (!egressAllowed(allowHosts, url)) {
      return { content: [{ type: "text", text: `egress blocked: not an allowed upstream` }], isError: true };
    }
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${cred.secret}`,
        accept: "application/vnd.github+json",
        "user-agent": "openharness-gateway",
      },
    });
    const body = await res.text();
    if (!res.ok) return { content: [{ type: "text", text: `github error ${res.status}` }], isError: true };
    return { content: [{ type: "text", text: body }] };
  }

  return {
    id: "github",
    tools,
    allowHosts,
    async call(toolName, args, cred) {
      const owner = typeof args.owner === "string" ? args.owner : "";
      const repo = typeof args.repo === "string" ? args.repo : "";
      if (!owner || !repo) {
        return { content: [{ type: "text", text: "owner and repo are required" }], isError: true };
      }
      const base = `https://${HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
      if (toolName === "github__list_issues") return get(base, cred);
      if (toolName === "github__get_issue") {
        const n = Number(args.number);
        if (!Number.isInteger(n)) {
          return { content: [{ type: "text", text: "number required" }], isError: true };
        }
        return get(`${base}/${n}`, cred);
      }
      return { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true };
    },
  };
}
