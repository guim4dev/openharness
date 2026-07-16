import { z } from "zod";
import type { HarnessManifest } from "./types.ts";

const providerConfig = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  credentialProfile: z.string().min(1),
});

const mcpServerSpec = z
  .object({
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
    // ENV VAR name (stdio) or HEADER name (http) -> credential REF name (never a value).
    secrets: z.record(z.string()).optional(),
    mandatory: z.boolean().optional(),
    tools: z.array(z.string()).optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.transport === "stdio" && !spec.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio transport requires 'command'",
        path: ["command"],
      });
    }
    if (spec.transport === "http" && !spec.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http transport requires 'url'",
        path: ["url"],
      });
    }
  });

export const harnessManifestSchema: z.ZodType<HarnessManifest, z.ZodTypeDef, unknown> = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  branding: z.object({
    displayName: z.string().min(1),
    icon: z.string().optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  }),
  systemPrompt: z.string().min(1),
  /** A file path (default) OR a curated-library ref of the form `lib:<name>`. */
  appendSystemPrompt: z.string().min(1).optional(),
  /** Dir path (relative to the definition root) of a curated PromptLibrary. */
  promptLibrary: z.string().min(1).optional(),
  skills: z.array(z.object({ path: z.string().min(1), mandatory: z.boolean() })).default([]),
  providers: z.object({ default: providerConfig }).catchall(providerConfig),
  mcp: z
    .object({
      // Server NAMES must not contain `__`: a tool bridges as `mcp__<server>__<tool>`,
      // so `a__b` + tool `c` and `a` + tool `b__c` would both become `mcp__a__b__c`
      // — one server could then shadow another's tool and dodge a policy rule.
      // Restricting the key keeps that mapping injective.
      servers: z.record(
        z
          .string()
          .regex(
            /^(?!.*__)[A-Za-z0-9._-]+$/,
            "mcp server name must be [A-Za-z0-9._-] and contain no '__' (it namespaces bridged tools as mcp__<server>__<tool>)",
          ),
        mcpServerSpec,
      ),
    })
    .optional(),
  gateway: z
    .object({
      url: z.string().min(1),
      pubkey: z.string().min(1),
      tools: z.array(z.string()).default([]),
    })
    .optional(),
});
