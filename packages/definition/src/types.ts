export interface HarnessSkillRef { path: string; mandatory: boolean }
export interface HarnessProviderConfig { provider: string; model: string; credentialProfile: string }
export interface HarnessBranding { displayName: string; icon?: string; accent?: string }

export interface HarnessManifest {
  name: string;
  version: string;
  branding: HarnessBranding;
  systemPrompt: string;
  skills: HarnessSkillRef[];
  providers: { default: HarnessProviderConfig } & Record<string, HarnessProviderConfig>;
}

/** Resolved definition: all paths absolute, system prompt read into memory. */
export interface HarnessDefinition {
  manifest: HarnessManifest;
  rootDir: string;
  systemPromptText: string;
  skillDirs: { path: string; mandatory: boolean }[];
  iconPath?: string;
}
