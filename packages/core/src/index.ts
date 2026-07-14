export { configDir } from "./paths.ts";
export { startSession } from "./session.ts";
export type { OpenHarnessSession, StartSessionOptions, ModelProvider } from "./session.ts";
export { createOpenHarnessAuthStorage } from "./pi-auth-storage.ts";
export type { OpenHarnessAuthStorage } from "./pi-auth-storage.ts";
export { createLiveSession } from "./live-session.ts";
export type { LiveSession, LiveSessionEvent, CreateLiveSessionOptions } from "./live-session.ts";
export { loadGatewayTools } from "./gateway-bridge.ts";
export type { GatewayAuth, LoadGatewayToolsOptions, LoadGatewayToolsResult } from "./gateway-bridge.ts";
export { buildPolicyExtension } from "./policy-extension.ts";
export type { PolicyExtensionOptions } from "./policy-extension.ts";
export { checkModel } from "@openharness/policy";
export type { Policy } from "@openharness/policy";
export { createFileAuditLog, verifyAuditLog, InMemoryAuditSink, hashCanonical, AUDIT_GENESIS } from "@openharness/audit";
export type { AuditSink, AuditEntry, AuditRecord, ToolDecision, VerifyResult } from "@openharness/audit";
export { loadAccounts, persistOnboardedAccount } from "./accounts.ts";
export type { LoadAccountsOptions, LoadedAccounts, PersistOnboardedAccountOptions } from "./accounts.ts";
export { runChat } from "./chat.ts";
export type { RunChatOptions, RunChatResult } from "./chat.ts";
export {
  stubStreamSimple,
  registerStubProvider,
  createStubModelRegistry,
  createToolCallingStubModelRegistry,
} from "./testing.ts";
export type { StubProviderOptions, ToolCallingStubOptions } from "./testing.ts";
