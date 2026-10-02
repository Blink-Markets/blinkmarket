export {
  createIdentityService,
  IdentityError,
  identityPaths,
  type IdentityService,
} from "./identity.js";
export const implementationStage = "m2-identity" as const;
export {
  createPreparationService,
  preparationPaths,
  type PreparationService,
} from "./preparation.js";
