import type { AuthProvider } from "../auth-provider.ts";
import type { SecretStore } from "../secret-store.ts";
import type { StoredCredential } from "../types.ts";

interface ApiKeyInput {
  accountId: string;
  apiKey: string;
  baseUrl?: string;
}

export function apiKeyAuthProvider(store: SecretStore): AuthProvider {
  return {
    id: "api-key",
    async authorize() {
      return { method: "paste", instructions: "Paste your API key (and optional base URL)." };
    },
    async callback(input: unknown): Promise<StoredCredential> {
      const { accountId, apiKey, baseUrl } = input as ApiKeyInput;
      if (!apiKey || apiKey.trim() === "") throw new Error("API key must not be empty");
      const secretRef = `api-key:${accountId}`;
      await store.set(secretRef, apiKey);
      return { kind: "api_key", secretRef, baseUrl };
    },
    async applyToRequest(cred, req) {
      const apiKey = await store.get(cred.secretRef);
      return { ...req, apiKey, baseUrl: cred.baseUrl ?? req.baseUrl };
    },
  };
}
