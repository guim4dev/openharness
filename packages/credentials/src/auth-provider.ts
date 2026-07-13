import type { StoredCredential } from "./types.ts";

export interface AuthorizeResult {
  method: "browser" | "device" | "paste";
  url?: string;
  instructions: string;
}
export interface ProviderRequest {
  headers: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
}
export interface AuthProvider {
  id: string;
  authorize(): Promise<AuthorizeResult>;
  callback(input: unknown): Promise<StoredCredential>;
  refresh?(cred: StoredCredential): Promise<StoredCredential>;
  applyToRequest(cred: StoredCredential, req: ProviderRequest): Promise<ProviderRequest>;
}

export class AuthProviderRegistry {
  private m = new Map<string, AuthProvider>();
  register(p: AuthProvider): void {
    this.m.set(p.id, p);
  }
  get(id: string): AuthProvider | undefined {
    return this.m.get(id);
  }
}
