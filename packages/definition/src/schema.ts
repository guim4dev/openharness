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
  skills: z.array(z.object({ path: z.string().min(1), mandatory: z.boolean() })).default([]),
  providers: z.object({ default: providerConfig }).catchall(providerConfig),
  mcp: z.object({ servers: z.record(mcpServerSpec) }).optional(),
});
