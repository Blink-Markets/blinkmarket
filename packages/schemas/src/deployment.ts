import { z } from "zod";
import { Address, Hash, DeploymentId, Uint256 } from "./core.ts";

const NonZeroAddress = Address.refine((v) => !/^0x0{40}$/i.test(v));
const NonZeroHash = Hash.refine((v) => !/^0x0{64}$/i.test(v));
export const DeploymentManifest = z
  .strictObject({
    status: z.literal("DEPLOYED"),
    chainId: z.literal(84532),
    deploymentId: DeploymentId,
    // Inclusive replay lower bound: no later than either contract's deployment.
    deploymentBlock: Uint256,
    contracts: z.strictObject({
      BlinkTestUSD: NonZeroAddress,
      BlinkMarket: NonZeroAddress,
    }),
    artifacts: z.strictObject({
      abiHashes: z.strictObject({
        BlinkTestUSD: NonZeroHash,
        BlinkMarket: NonZeroHash,
      }),
      bytecodeHashes: z.strictObject({
        BlinkTestUSD: NonZeroHash,
        BlinkMarket: NonZeroHash,
      }),
      compiler: z.literal("0.8.30"),
      gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
      dependencies: z
        .record(z.string(), z.string().min(1))
        .refine((v) => Object.keys(v).length > 0),
    }),
    roles: z.strictObject({
      admin: NonZeroAddress,
      resultProposer: NonZeroAddress,
      challenger: NonZeroAddress,
      arbiter: NonZeroAddress,
      maker: NonZeroAddress,
      faucetMinter: NonZeroAddress,
    }),
    parameters: z.strictObject({
      collateralDecimals: z.literal(6),
      quoteDefaultTtlSeconds: z.literal(30),
      quoteMaxTtlSeconds: z.literal(60),
      makerSpreadBps: z.literal(200),
      maxFillShares: z.literal("100"),
      maxMarketPairs: z.literal("10000"),
      maxTakerShares: z.literal("500"),
    }),
    tradingEnabled: z.boolean(),
  })
  .superRefine((m, ctx) => {
    const roles = Object.values(m.roles).map((v) => v.toLowerCase());
    if (new Set(roles).size !== roles.length)
      ctx.addIssue({
        code: "custom",
        message: "Role addresses must be distinct",
      });
    const contracts = Object.values(m.contracts).map((v) => v.toLowerCase());
    if (
      new Set(contracts).size !== 2 ||
      contracts.some((v) => roles.includes(v))
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid contract/role address overlap",
      });
  });
export type DeploymentManifest = z.infer<typeof DeploymentManifest>;
export function requireDeployment(
  input: unknown,
  expectedDeploymentId: string,
  rpcChainId: number,
): DeploymentManifest {
  const result = DeploymentManifest.parse(input);
  if (rpcChainId !== 84532 || result.deploymentId !== expectedDeploymentId)
    throw new Error("DEPLOYMENT_MISMATCH");
  return result;
}
