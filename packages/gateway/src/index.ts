export type { ToolSpec, ToolCatalog } from "./catalog.ts";
export { normalizeCatalog } from "./catalog.ts";
export { createGateway } from "./server.ts";
export type { Gateway, GatewayOptions } from "./server.ts";
export {
  generateAuthKeypair,
  thumbprint,
  mintGatewayToken,
  createDpopProof,
  validateRequest,
  isDeny,
} from "./auth.ts";
export type { GatewayClaims, Principal, Deny, IncomingRequest } from "./auth.ts";
export { decide } from "./pdp.ts";
