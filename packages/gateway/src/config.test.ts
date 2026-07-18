import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateAuthKeypair } from "./auth.ts";
import { loadGatewayServerConfig } from "./config.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Write keys + policy + a config whose `tokenExchange` block is the given value; return its path. */
function writeConfig(tokenExchange: Record<string, unknown> | undefined): string {
  dir = mkdtempSync(join(tmpdir(), "oh-gw-cfg-"));
  const keys = generateAuthKeypair();
  writeFileSync(join(dir, "gw.pub"), keys.publicKey);
  writeFileSync(join(dir, "gw.key"), keys.privateKey);
  // A static-key variant needs the IdP PEM on disk (a JWKS variant references a URL).
  const idp = generateAuthKeypair();
  writeFileSync(join(dir, "idp.pub"), idp.publicKey);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ default: "allow", rules: [] }));
  const config: Record<string, unknown> = {
    host: "127.0.0.1",
    keys: { publicKey: "gw.pub", privateKey: "gw.key" },
    policy: "policy.json",
    policyVersion: "1.0.0",
    auditPath: "audit.log",
    catalog: [{ name: "github__list_issues", connectorId: "github", upstreamId: "github" }],
    connectors: [{ id: "github", type: "github-read" }],
    ...(tokenExchange ? { tokenExchange } : {}),
  };
  const p = join(dir, "gateway.json");
  writeFileSync(p, JSON.stringify(config));
  return p;
}

test("tokenExchange with idpPublicKey only resolves to the static-key variant", () => {
  const resolved = loadGatewayServerConfig(
    writeConfig({ idpPublicKey: "idp.pub", issuer: "https://idp.acme.com", audience: "openharness-gateway" }),
  );
  expect(resolved.tokenExchange).toBeDefined();
  const tx = resolved.tokenExchange!;
  expect("idpPublicKeyPem" in tx).toBe(true);
  expect("jwksUri" in tx).toBe(false);
  if ("idpPublicKeyPem" in tx) expect(tx.idpPublicKeyPem).toContain("BEGIN PUBLIC KEY");
});

test("tokenExchange with jwksUri only resolves to the JWKS variant (no PEM read)", () => {
  const resolved = loadGatewayServerConfig(
    writeConfig({
      jwksUri: "https://idp.acme.com/.well-known/jwks.json",
      algorithms: ["RS256", "ES256"],
      issuer: "https://idp.acme.com",
      audience: "openharness-gateway",
    }),
  );
  expect(resolved.tokenExchange).toBeDefined();
  const tx = resolved.tokenExchange!;
  expect("jwksUri" in tx).toBe(true);
  expect("idpPublicKeyPem" in tx).toBe(false);
  if ("jwksUri" in tx) {
    expect(tx.jwksUri).toBe("https://idp.acme.com/.well-known/jwks.json");
    expect(tx.algorithms).toEqual(["RS256", "ES256"]);
  }
});

test("tokenExchange with BOTH idpPublicKey and jwksUri is rejected", () => {
  expect(() =>
    loadGatewayServerConfig(
      writeConfig({
        idpPublicKey: "idp.pub",
        jwksUri: "https://idp.acme.com/jwks",
        issuer: "https://idp.acme.com",
        audience: "openharness-gateway",
      }),
    ),
  ).toThrow(/exactly one|idpPublicKey|jwksUri/i);
});

test("tokenExchange with NEITHER idpPublicKey nor jwksUri is rejected", () => {
  expect(() =>
    loadGatewayServerConfig(writeConfig({ issuer: "https://idp.acme.com", audience: "openharness-gateway" })),
  ).toThrow(/exactly one|idpPublicKey|jwksUri/i);
});

test("tokenExchange with a non-https (non-loopback) jwksUri is rejected at config parse", () => {
  expect(() =>
    loadGatewayServerConfig(
      writeConfig({
        jwksUri: "http://idp.acme.com/jwks",
        issuer: "https://idp.acme.com",
        audience: "openharness-gateway",
      }),
    ),
  ).toThrow(/https|cleartext/i);
});

test("tokenExchange with a loopback-http jwksUri is allowed (dev)", () => {
  const resolved = loadGatewayServerConfig(
    writeConfig({ jwksUri: "http://127.0.0.1:9099/jwks", issuer: "https://idp.acme.com", audience: "openharness-gateway" }),
  );
  const tx = resolved.tokenExchange!;
  expect("jwksUri" in tx && tx.jwksUri).toBe("http://127.0.0.1:9099/jwks");
});
