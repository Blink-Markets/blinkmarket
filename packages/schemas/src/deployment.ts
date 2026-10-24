import { z } from "zod";
import { Address, DeploymentId, Hash } from "./core.ts";
import { GovernorSettings, ProtocolParams } from "./protocol-params.ts";

// Manifest v2: shared contracts plus one generation of the P1 protocol. The v0.1 manifest
// (alpha-2) is historical and lives in deployment-v1.ts.
const NonZeroAddress = Address.refine((v) => !/^0x0{40}$/i.test(v));

const ContractRecord = z.strictObject({
  address: NonZeroAddress,
  abiHash: Hash,
  runtimeHash: Hash,
  deployTx: Hash,
  block: z.number().int().min(0),
});

export const ProtocolDeployment = z
  .strictObject({
    schema: z.literal("blink.deployment/2"),
    deploymentId: DeploymentId,
    chainId: z.literal(84532),
    deployer: NonZeroAddress,
    treasury: NonZeroAddress,
    shared: z.strictObject({
      faucet: NonZeroAddress,
      busd: NonZeroAddress,
      token: NonZeroAddress,
      priceSource: NonZeroAddress,
      governor: NonZeroAddress,
      anchor: NonZeroAddress,
    }),
    generation: z.strictObject({
      index: z.number().int().min(0),
      registry: NonZeroAddress,
      jurors: NonZeroAddress,
      markets: NonZeroAddress,
      resolution: NonZeroAddress,
      previousRegistry: NonZeroAddress.nullable(),
    }),
    params: ProtocolParams,
    governor: GovernorSettings,
    tokenPriceMicros: z.number().int().positive(),
    contracts: z.record(z.string().min(1), ContractRecord),
    startBlock: z.number().int().min(0),
    releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .superRefine((m, ctx) => {
    const slots = [
      ...Object.values(m.shared),
      m.generation.registry,
      m.generation.jurors,
      m.generation.markets,
      m.generation.resolution,
      ...(m.generation.previousRegistry ? [m.generation.previousRegistry] : []),
    ].map((v) => v.toLowerCase());
    if (new Set(slots).size !== slots.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate contract address across slots",
      });
    const recorded = Object.values(m.contracts).map((c) =>
      c.address.toLowerCase(),
    );
    if (new Set(recorded).size !== recorded.length)
      ctx.addIssue({
        code: "custom",
        path: ["contracts"],
        message: "Duplicate address in contracts",
      });
  });
export type ProtocolDeployment = z.infer<typeof ProtocolDeployment>;

export type ParsedProtocolDeployment =
  { ok: true; manifest: ProtocolDeployment } | { ok: false; reason: string };

/** Parses a manifest file; a v0.1 manifest (no `schema`, status DEPLOYED) is reported as historical. */
export function parseProtocolDeployment(
  input: unknown,
): ParsedProtocolDeployment {
  if (
    typeof input === "object" &&
    input !== null &&
    !("schema" in input) &&
    "status" in input &&
    "roles" in input
  )
    return { ok: false, reason: "HISTORICAL_V1_MANIFEST" };
  const parsed = ProtocolDeployment.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const issue = parsed.error.issues[0]!;
  return {
    ok: false,
    reason: `INVALID_MANIFEST: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
  };
}
