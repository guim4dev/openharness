import { createHash, sign, verify } from "node:crypto";

/**
 * Artifact provenance verification — the mature supply-chain standard, buildable
 * and testable offline. An artifact (the pinned runner, an MCP server package,
 * the built bundle) carries a signed **in-toto/SLSA provenance** statement wrapped
 * in a **DSSE** envelope (the exact format npm provenance, cosign, and SLSA all
 * use). Verifying it proves three things before we trust the artifact:
 *
 *   1. the statement is signed by a key we trust (the trust root),
 *   2. its subject digest matches the artifact we actually have (no swap), and
 *   3. it was produced by a builder we allow (the SLSA "trusted builder" check).
 *
 * This module implements the real DSSE Pre-Authentication Encoding + ed25519
 * verification offline. In production the trust root's verifying key is
 * discovered via Sigstore (a Fulcio-issued cert + a Rekor transparency-log
 * inclusion proof) — that key DISCOVERY needs network and is the swappable seam
 * (`TrustRoot`); the cryptographic verification here is identical either way.
 */

/** A DSSE envelope: base64 payload + type + one or more signatures. */
export interface DsseEnvelope {
  payload: string; // base64 of the in-toto Statement JSON
  payloadType: string; // e.g. "application/vnd.in-toto+json"
  signatures: { keyid?: string; sig: string }[]; // sig = base64(ed25519 signature)
}

/** in-toto Statement v1 with a SLSA provenance predicate (subset we verify). */
export interface InTotoStatement {
  _type: string; // "https://in-toto.io/Statement/v1"
  subject: { name: string; digest: Record<string, string> }[];
  predicateType: string; // "https://slsa.dev/provenance/v1"
  predicate?: { runDetails?: { builder?: { id?: string } } };
}

/** The verifying material. Production resolves `keys` via Sigstore (Fulcio/Rekor). */
export interface TrustRoot {
  /** ed25519 PUBLIC keys (PEM) any one of which may have signed the envelope. */
  keys: string[];
  /**
   * Allowed SLSA builder identities (`predicate.runDetails.builder.id`). A
   * provenance signed by a trusted key but produced by an UNLISTED builder is
   * rejected — this is what stops a leaked key from minting arbitrary provenance.
   */
  allowedBuilders: string[];
}

export interface ArtifactRef {
  /** Must equal the statement subject name (e.g. a package URL). */
  name: string;
  /** The artifact's actual sha256 digest (hex) — recomputed from bytes, not trusted input. */
  sha256: string;
}

export interface ProvenanceVerdict {
  verified: boolean;
  reason?: string;
  subjectName?: string;
  builderId?: string;
}

/** The types real SLSA/in-toto provenance carries — bound, not merely typed. */
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

/** DSSE Pre-Authentication Encoding: what is actually signed/verified. */
function pae(payloadType: string, payload: Buffer): Buffer {
  const t = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${t.length} `, "utf8"),
    t,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

/** sha256 hex of bytes — the digest a subject entry must match. */
export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify an artifact's provenance envelope against a trust root. Returns a
 * verdict; NEVER throws on a bad signature/mismatch (a verification result is
 * data, not an exception) — it throws only on a structurally unusable envelope.
 */
export function verifyProvenance(artifact: ArtifactRef, envelope: DsseEnvelope, trust: TrustRoot): ProvenanceVerdict {
  // 0. Structural guard. A malformed / hand-forged envelope (missing payload,
  //    non-array signatures, a non-string sig) is a FAILED verification, not a
  //    crash — a throw here would let a malicious upstream turn provenance
  //    verification into a denial of the whole doctor run. Honor the no-throw
  //    contract for every shape an attacker controls.
  if (envelope == null || typeof envelope !== "object") return { verified: false, reason: "envelope is not an object" };
  if (typeof envelope.payload !== "string") return { verified: false, reason: "envelope.payload is missing" };
  if (typeof envelope.payloadType !== "string") return { verified: false, reason: "envelope.payloadType is missing" };
  if (!Array.isArray(envelope.signatures)) return { verified: false, reason: "envelope.signatures is missing" };

  const payload = Buffer.from(envelope.payload, "base64");
  const signed = pae(envelope.payloadType, payload);

  // 1. At least one signature must verify under some trusted key.
  const anyKeyVerifies = envelope.signatures.some((s) => {
    if (!s || typeof s.sig !== "string") return false;
    const sig = Buffer.from(s.sig, "base64");
    return trust.keys.some((pem) => {
      try {
        return verify(null, signed, pem, sig);
      } catch {
        return false; // a malformed key/sig is a failed verification, not a crash
      }
    });
  });
  if (!anyKeyVerifies) return { verified: false, reason: "no trusted key verified the envelope signature" };

  // 1b. The payload type is bound into the PAE (so it cannot be relabeled), but
  //     its VALUE must also be the in-toto type — otherwise any DSSE document a
  //     trusted key signs (a different attestation kind, a Rekor entry) could be
  //     laundered into a "verified provenance" verdict (cross-type confusion).
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE)
    return { verified: false, reason: `unexpected payloadType '${envelope.payloadType}'` };

  // 2. Parse the signed statement (only AFTER the signature is trusted).
  let stmt: InTotoStatement;
  try {
    stmt = JSON.parse(payload.toString("utf8")) as InTotoStatement;
  } catch {
    return { verified: false, reason: "signed payload is not valid JSON" };
  }
  if (stmt == null || typeof stmt !== "object") return { verified: false, reason: "signed payload is not an object" };

  // 2b. Bind the statement/predicate types — this IS a SLSA in-toto provenance,
  //     not some other signed document (the cross-type confused-deputy defense).
  if (stmt._type !== IN_TOTO_STATEMENT_V1) return { verified: false, reason: `unexpected statement _type '${stmt._type}'` };
  if (stmt.predicateType !== SLSA_PROVENANCE_V1)
    return { verified: false, reason: `unexpected predicateType '${stmt.predicateType}'` };

  // 3. Subject must name our artifact AND carry a sha256 that matches its bytes.
  const subject = stmt.subject?.find((s) => s.name === artifact.name);
  if (!subject) return { verified: false, reason: `no subject named '${artifact.name}' in the statement` };
  const attestedDigest = subject.digest?.sha256?.toLowerCase();
  if (!attestedDigest) return { verified: false, reason: "subject has no sha256 digest", subjectName: subject.name };
  if (attestedDigest !== artifact.sha256.toLowerCase())
    return { verified: false, reason: "artifact digest does not match the attested subject digest", subjectName: subject.name };

  // 4. The builder identity must be one we allow (SLSA trusted-builder).
  const builderId = stmt.predicate?.runDetails?.builder?.id;
  if (!builderId) return { verified: false, reason: "no builder id in the SLSA provenance", subjectName: subject.name };
  if (!trust.allowedBuilders.includes(builderId))
    return { verified: false, reason: `builder '${builderId}' is not an allowed builder`, subjectName: subject.name, builderId };

  return { verified: true, subjectName: subject.name, builderId };
}

/**
 * Produce a signed DSSE provenance envelope. A SEED/TEST helper mirroring what a
 * CI builder (or `npm publish --provenance`) emits — in production the envelope
 * comes from the build system + Sigstore, never from here. `statement` is signed
 * as-is; `sha256Hex` computes a subject digest from artifact bytes.
 */
export function signProvenance(statement: InTotoStatement, privateKeyPem: string, keyid?: string): DsseEnvelope {
  const payloadType = IN_TOTO_PAYLOAD_TYPE;
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const sig = sign(null, pae(payloadType, payload), privateKeyPem).toString("base64");
  return { payload: payload.toString("base64"), payloadType, signatures: [{ ...(keyid ? { keyid } : {}), sig }] };
}
