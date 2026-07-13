import { z } from "zod";
import type { HarnessManifest } from "./types.ts";

const providerConfig = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  credentialProfile: z.string().min(1),
});

export const harnessManifestSchema: z.ZodType<HarnessManifest> = z.object({
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
});
