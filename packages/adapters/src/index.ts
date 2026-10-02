export { createUnitOfWork } from "./database.js";
export { migrate, migratePostgres } from "./migrations.js";
export {
  createSpecArchive,
  encodeNewSpec,
  verifySpecBytes,
} from "./spec-archive.js";
export { fileObjectStore } from "./file-object-store.js";
export { verifyDeploymentOnChain } from "./deployment-verifier.js";
export {
  postgresIdentityStore,
  assertIdentityRuntimeRole,
} from "./identity-store.js";
export { identityCrypto } from "./identity-crypto.js";
export { identityAdmin } from "./identity-admin.js";
// Runtime wiring is explicit: the API defaults to scaffold; identity mode uses only these adapters.
export { postgresPreparationStore } from "./preparation-store.js";
export { evidenceAdmin } from "./evidence-admin.js";
