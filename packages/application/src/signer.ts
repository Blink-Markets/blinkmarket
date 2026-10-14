import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  hashTypedData,
  keccak256,
  parseTransaction,
  serializeTransaction,
  stringToHex,
  type LocalAccount,
} from "viem";
import { quoteTypes, type DeploymentManifest } from "@blink/schemas";
import {
  canonicalJson,
  checkGasCaps,
  checkMakerQuote,
  checkTransactionCall,
  gasLimitFor,
  intentRole,
  maxFeePerGas,
  parseQuoteMessage,
  parseTransactionPayload,
  quoteDomain,
  replacementFeesAccepted,
  signRoles,
  SIGNING_POLICY_VERSION,
  type QuoteMessage,
  type SignRole,
} from "@blink/domain";
import type {
  ArtifactRecord,
  CallEncoder,
  Hex,
  IntentRecord,
  SignerRpc,
  SignerStore,
  SignerTransaction,
  SignRequestRecord,
} from "@blink/ports";

const CHAIN_ID = 84532;

export class QuoteCheckRejection extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type QuoteCheck = (input: {
  signRequest: SignRequestRecord;
  intent: IntentRecord;
  /** The signer transaction's database client, so the check sees the same snapshot. */
  client: unknown;
}) => Promise<void>;

export interface SignerCaller {
  name: string;
  tokenSha256: string;
  roles: SignRole[];
}
export interface SignerPolicy {
  l1FeeMode: "oracle" | "local-none";
  perTxCapWei: bigint;
  dailyCapWei: bigint;
}
export interface SignerDeps {
  store: SignerStore;
  keys: Partial<Record<SignRole, LocalAccount>>;
  rpc: SignerRpc;
  deployment: DeploymentManifest;
  callers: SignerCaller[];
  policy: SignerPolicy;
  /** Calldata comes from the one canonical ABI; adapters provide it. */
  encodeCall: CallEncoder;
  quoteCheck?: QuoteCheck;
  /** Signer wall clock in milliseconds; tests inject it. */
  now?: () => number;
  /** Called with the cause of a 503, so operators can see it; never part of the response. */
  onError?: (error: unknown) => void;
}

/** What a caller must send to be able to ask for the same hash the signer will check. */
export function transactionRequestHash(payload: Record<string, unknown>): Hex {
  return keccak256(stringToHex(canonicalJson(payload)));
}
export function quoteTypedData(
  manifest: Pick<DeploymentManifest, "contracts">,
  quote: QuoteMessage,
) {
  return {
    domain: quoteDomain(manifest),
    types: quoteTypes,
    primaryType: "Quote" as const,
    message: {
      marketId: quote.marketId,
      specHash: quote.specHash as Hex,
      maker: quote.maker as Hex,
      taker: quote.taker as Hex,
      side: quote.side,
      quantity: quote.quantity,
      priceBps: Number(quote.priceBps),
      validAfter: quote.validAfter,
      expiresAt: quote.expiresAt,
      nonce: quote.nonce,
      epoch: quote.epoch,
    },
  };
}
/** The EIP-712 digest of a Quote message (decimal-string integers), as the signer recomputes it. */
export function quoteRequestHash(
  manifest: Pick<DeploymentManifest, "contracts">,
  message: unknown,
): Hex {
  const quote = parseQuoteMessage(message);
  if (!quote) throw new Error("QUOTE_INVALID");
  return hashTypedData(quoteTypedData(manifest, quote));
}

/** Refuses a chain other than 84532 and a deployment that is missing, disabled or different. */
export async function assertSignerStartup(deps: {
  store: SignerStore;
  rpc: SignerRpc;
  deployment: DeploymentManifest;
}) {
  const chainId = await deps.rpc.chainId();
  if (chainId === 8453) throw new Error("MAINNET_REFUSED");
  if (chainId !== CHAIN_ID || deps.deployment.chainId !== CHAIN_ID)
    throw new Error("RPC_CHAIN_MISMATCH");
  const row = await deps.store.loadDeployment(deps.deployment.deploymentId);
  if (!row) throw new Error("DEPLOYMENT_NOT_FOUND");
  if (!row.enabled) throw new Error("DEPLOYMENT_DISABLED");
  if (canonicalJson(row.manifest) !== canonicalJson(deps.deployment))
    throw new Error("DEPLOYMENT_MISMATCH");
}

type Signed = {
  state: "SIGNED";
  artifactId: string;
  artifactHash: string;
  signature?: string;
  txHash?: string;
};
type Decision = { ok: true; result: Signed } | { ok: false; code: string };
type Outcome =
  | { kind: "signed"; result: Signed }
  | { kind: "rejected"; code: string }
  | { kind: "error"; status: number; code: string };
const reject = (code: string): Decision => ({ ok: false, code });
const isRpcUnavailable = (error: unknown) =>
  error instanceof Error && error.message === "RPC_UNAVAILABLE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (value: string) => value.toLowerCase();

export function createSignerService(deps: SignerDeps) {
  const { store, rpc, deployment, policy } = deps;
  const now = deps.now ?? Date.now;
  const keyAddress = (role: SignRole) => deps.keys[role]?.address;

  // --- startup invariants: a wrong key must stop the process, not sign ---
  const manifestAddresses = new Set(
    [
      ...Object.values(deployment.roles),
      ...Object.values(deployment.contracts),
    ].map(lower),
  );
  if (
    deps.keys.maker &&
    lower(deps.keys.maker.address) !== lower(deployment.roles.maker)
  )
    throw new Error("MAKER_KEY_MISMATCH");
  if (
    deps.keys.faucet &&
    lower(deps.keys.faucet.address) !== lower(deployment.roles.faucetMinter)
  )
    throw new Error("FAUCET_KEY_MISMATCH");
  for (const role of ["keeper", "trader"] as const) {
    const address = keyAddress(role);
    if (address && manifestAddresses.has(lower(address)))
      throw new Error(role.toUpperCase() + "_KEY_ADDRESS_FORBIDDEN");
  }
  const configured = signRoles.flatMap((role) => {
    const address = keyAddress(role);
    return address ? [lower(address)] : [];
  });
  if (new Set(configured).size !== configured.length)
    throw new Error("ROLE_KEYS_NOT_DISTINCT");
  if (policy.perTxCapWei <= 0n || policy.dailyCapWei < policy.perTxCapWei)
    throw new Error("INVALID_SIGNER_POLICY");
  const callers = deps.callers.map((caller) => {
    if (
      !/^[0-9a-f]{64}$/.test(caller.tokenSha256) ||
      !caller.name ||
      !caller.roles.every((role) => signRoles.includes(role))
    )
      throw new Error("INVALID_SIGNER_CALLER");
    return {
      name: caller.name,
      hash: Buffer.from(caller.tokenSha256, "hex"),
      roles: new Set(caller.roles),
    };
  });

  function authenticate(token: string | undefined) {
    if (!token) return null;
    const digest = createHash("sha256").update(token, "utf8").digest();
    let match: (typeof callers)[number] | null = null;
    // Compare against every caller so timing does not reveal which one matched.
    for (const caller of callers)
      if (timingSafeEqual(digest, caller.hash)) match = caller;
    return match;
  }

  const addresses = () =>
    Object.fromEntries(
      signRoles.flatMap((role) => {
        const address = keyAddress(role);
        return address ? [[role, address]] : [];
      }),
    ) as Partial<Record<SignRole, string>>;

  async function persistArtifact(
    tx: SignerTransaction,
    request: SignRequestRecord,
    intent: IntentRecord,
    artifact: {
      artifactHash: Hex;
      signature: Hex | null;
      rawTransaction: Hex | null;
      maxCostWei: bigint | null;
    },
  ): Promise<Decision> {
    const id = randomUUID();
    await tx.insertArtifact({ id, signRequestId: request.id, ...artifact });
    await tx.markSigned(request.id, intent.id);
    return {
      ok: true,
      result: {
        state: "SIGNED",
        artifactId: id,
        artifactHash: artifact.artifactHash,
        ...(artifact.signature ? { signature: artifact.signature } : {}),
        ...(artifact.rawTransaction ? { txHash: artifact.artifactHash } : {}),
      },
    };
  }

  async function signQuote(
    tx: SignerTransaction,
    request: SignRequestRecord,
    intent: IntentRecord,
    enabled: boolean,
  ): Promise<Decision> {
    if (request.artifactVersion !== 1) return reject("VERSION_NOT_ALLOWED");
    const account = deps.keys.maker!;
    const parsed = parseQuoteMessage(request.unsignedPayload);
    const checked = checkMakerQuote({
      manifest: deployment,
      makerAddress: account.address,
      deploymentEnabled: enabled,
      nowMs: now(),
      message: request.unsignedPayload,
      market: parsed
        ? await tx.market(intent.deploymentId, parsed.marketId)
        : null,
      epoch: parsed ? await tx.makerEpoch(intent.deploymentId) : null,
    });
    if (!checked.ok) return reject(checked.code);
    const typed = quoteTypedData(deployment, checked.quote);
    const digest = hashTypedData(typed);
    if (digest !== lower(request.requestHash))
      return reject("PAYLOAD_HASH_MISMATCH");
    if (deps.quoteCheck) {
      try {
        await deps.quoteCheck({
          signRequest: request,
          intent,
          client: tx.client,
        });
      } catch (error) {
        if (error instanceof QuoteCheckRejection) return reject(error.code);
        throw error;
      }
    }
    const signature = await account.signTypedData(typed);
    return persistArtifact(tx, request, intent, {
      artifactHash: digest,
      signature,
      rawTransaction: null,
      maxCostWei: null,
    });
  }

  async function signTransaction(
    tx: SignerTransaction,
    request: SignRequestRecord,
    intent: IntentRecord,
    actor: string,
  ): Promise<Decision> {
    const role = request.role;
    const account = deps.keys[role]!;
    const replacement = request.artifactVersion > 1;
    const split = parseTransactionPayload(request.unsignedPayload, replacement);
    if (!split) return reject("PAYLOAD_INVALID");
    const checked = checkTransactionCall({
      manifest: deployment,
      addresses: addresses(),
      role,
      kind: intent.kind,
      payload: split.call,
    });
    if (!checked.ok) return reject(checked.code);
    if (
      transactionRequestHash(request.unsignedPayload) !==
      lower(request.requestHash)
    )
      return reject("PAYLOAD_HASH_MISMATCH");
    const to = checked.call.to as Hex;
    const data = deps.encodeCall(checked.call);

    let nonce: bigint;
    let gasLimit: bigint;
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    // Serialize allocation per sender before any nonce or fee decision.
    await tx.lockSender(CHAIN_ID, account.address);
    if (!replacement) {
      if (intent.state !== "PREPARED") return reject("INTENT_NOT_SIGNABLE");
      // An allocation without an artifact cannot come from this flow: never hand out another.
      if ((await tx.allocationOf(intent.id)) !== null)
        throw new Error("ALLOCATION_WITHOUT_ARTIFACT");
      const rpcPending = await rpc.pendingNonce(account.address);
      const allocated = await tx.maxAllocatedNonce(CHAIN_ID, account.address);
      const dbNext = allocated === null ? rpcPending : allocated + 1n;
      if (rpcPending > dbNext) {
        await tx.audit({
          actor,
          action: "signer.nonce_unknown_occupant",
          resource: lower(account.address),
          reason: `rpcPending=${rpcPending} dbNext=${dbNext} intent=${intent.id}`,
          requestId: request.id,
        });
        return reject("NONCE_UNKNOWN_OCCUPANT");
      }
      nonce = dbNext;
      let estimate: bigint;
      try {
        estimate = await rpc.estimateGas({ from: account.address, to, data });
      } catch (error) {
        if (isRpcUnavailable(error)) throw error;
        return reject("GAS_ESTIMATE_FAILED");
      }
      gasLimit = gasLimitFor(estimate);
      const priority = await rpc.maxPriorityFeePerGas();
      fees = {
        maxFeePerGas: maxFeePerGas(await rpc.baseFeePerGas(), priority),
        maxPriorityFeePerGas: priority,
      };
    } else {
      if (!["SIGNED", "SUBMITTED", "UNKNOWN"].includes(intent.state))
        return reject("INTENT_NOT_SIGNABLE");
      const versions = await tx.signedVersions(intent.id);
      const last = versions.at(-1);
      const base = versions[0];
      if (
        !last ||
        !base ||
        versions.length !== request.artifactVersion - 1 ||
        versions.some((v, index) => v.artifactVersion !== index + 1) ||
        !last.rawTransaction
      )
        return reject("REPLACEMENT_BASE_MISSING");
      const allocated = await tx.allocationOf(intent.id);
      const prev = parseTransaction(last.rawTransaction);
      if (
        allocated === null ||
        prev.type !== "eip1559" ||
        BigInt(prev.nonce ?? -1) !== allocated ||
        !prev.gas ||
        !prev.maxFeePerGas ||
        !prev.maxPriorityFeePerGas
      )
        throw new Error("REPLACEMENT_BASE_INCONSISTENT");
      // The economic call must be exactly the first version's: same target, same calldata.
      const first = parseTransactionPayload(base.unsignedPayload, false);
      const firstChecked = first
        ? checkTransactionCall({
            manifest: deployment,
            addresses: addresses(),
            role,
            kind: intent.kind,
            payload: first.call,
          })
        : null;
      if (
        !firstChecked?.ok ||
        firstChecked.call.to !== checked.call.to ||
        deps.encodeCall(firstChecked.call) !== data
      )
        return reject("REPLACEMENT_CALLDATA_CHANGED");
      if (
        !replacementFeesAccepted(
          {
            maxFeePerGas: prev.maxFeePerGas,
            maxPriorityFeePerGas: prev.maxPriorityFeePerGas,
          },
          split.fees!,
        )
      )
        return reject("REPLACEMENT_FEE_TOO_LOW");
      nonce = allocated;
      gasLimit = prev.gas;
      fees = split.fees!;
    }
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("NONCE_OUT_OF_RANGE");

    const unsigned = {
      type: "eip1559" as const,
      chainId: CHAIN_ID,
      to,
      data,
      value: 0n,
      nonce: Number(nonce),
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    const l1Fee =
      policy.l1FeeMode === "oracle"
        ? await rpc.l1Fee(serializeTransaction(unsigned))
        : 0n;
    const maxCost = gasLimit * fees.maxFeePerGas + l1Fee;
    const usage = await tx.gasUsage(role);
    const capped = checkGasCaps({
      maxCost,
      reservedWei: usage.reservedWei,
      spentWei: usage.spentWei,
      perTxCapWei: policy.perTxCapWei,
      dailyCapWei: policy.dailyCapWei,
    });
    if (capped) return reject(capped);

    if (!replacement)
      await tx.allocateNonce({
        chainId: CHAIN_ID,
        sender: account.address,
        nonce,
        intentId: intent.id,
      });
    await tx.reserveGas(role, maxCost);
    // RFC 6979: the same unsigned transaction always yields the same bytes and hash.
    const raw = await account.signTransaction(unsigned);
    return persistArtifact(tx, request, intent, {
      artifactHash: keccak256(raw),
      signature: null,
      rawTransaction: raw,
      maxCostWei: maxCost,
    });
  }

  async function decide(
    tx: SignerTransaction,
    request: SignRequestRecord,
    actor: string,
  ): Promise<Decision> {
    const intent = await tx.lockIntent(request.intentId);
    if (!intent) throw new Error("INTENT_MISSING");
    if (
      intent.role !== request.role ||
      intentRole(intent.kind) !== request.role
    )
      return reject("INTENT_MISMATCH");
    if (intent.deploymentId !== deployment.deploymentId)
      return reject("DEPLOYMENT_MISMATCH");
    if (request.policyVersion !== SIGNING_POLICY_VERSION)
      return reject("POLICY_VERSION_UNSUPPORTED");
    const enabled = await tx.deploymentEnabled(intent.deploymentId);
    if (intent.kind === "MAKER_QUOTE") {
      if (intent.state !== "PREPARED") return reject("INTENT_NOT_SIGNABLE");
      return signQuote(tx, request, intent, enabled);
    }
    if (!enabled) return reject("DEPLOYMENT_DISABLED");
    return signTransaction(tx, request, intent, actor);
  }

  const signedFrom = (artifact: ArtifactRecord): Signed => ({
    state: "SIGNED",
    artifactId: artifact.id,
    artifactHash: artifact.artifactHash,
    ...(artifact.signature ? { signature: artifact.signature } : {}),
    ...(artifact.rawTransaction ? { txHash: artifact.artifactHash } : {}),
  });

  async function process(
    tx: SignerTransaction,
    caller: (typeof callers)[number],
    input: { signRequestId: string; expectedRequestHash: string },
  ): Promise<Outcome> {
    const request = await tx.lockSignRequest(input.signRequestId);
    if (!request)
      return { kind: "error", status: 404, code: "SIGN_REQUEST_NOT_FOUND" };
    if (!caller.roles.has(request.role) || !deps.keys[request.role])
      return { kind: "error", status: 403, code: "ROLE_DENIED" };
    const actor = "signer:" + caller.name;
    // The caller must agree on what is being signed; a disagreement leaves the request untouched.
    if (lower(request.requestHash) !== input.expectedRequestHash) {
      await tx.audit({
        actor,
        action: "signer.request_hash_mismatch",
        resource: request.id,
        reason: "REQUEST_HASH_MISMATCH",
        requestId: request.id,
      });
      return { kind: "rejected", code: "REQUEST_HASH_MISMATCH" };
    }
    if (request.state === "SIGNED") {
      const artifact = await tx.artifactOf(request.id);
      if (!artifact) throw new Error("ARTIFACT_MISSING");
      return { kind: "signed", result: signedFrom(artifact) };
    }
    if (request.state === "REJECTED")
      return { kind: "rejected", code: request.rejectCode ?? "REJECTED" };
    const decision = await decide(tx, request, actor);
    if (decision.ok) {
      await tx.audit({
        actor,
        action: "signer.signed",
        resource: request.id,
        reason: decision.result.artifactHash,
        requestId: request.id,
      });
      return { kind: "signed", result: decision.result };
    }
    await tx.markRejected(request.id, decision.code);
    await tx.audit({
      actor,
      action: "signer.rejected",
      resource: request.id,
      reason: decision.code,
      requestId: request.id,
    });
    return { kind: "rejected", code: decision.code };
  }

  return {
    async handle(
      token: string | undefined,
      body: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const caller = authenticate(token);
      if (!caller)
        return {
          status: 401,
          body: { code: "UNAUTHORIZED", message: "Unknown caller" },
        };
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        typeof (body as Record<string, unknown>).signRequestId !== "string" ||
        typeof (body as Record<string, unknown>).expectedRequestHash !==
          "string" ||
        !UUID.test((body as Record<string, string>).signRequestId!) ||
        !/^0x[0-9a-fA-F]{64}$/.test(
          (body as Record<string, string>).expectedRequestHash!,
        )
      )
        return {
          status: 400,
          body: { code: "INVALID_REQUEST", message: "Invalid sign request" },
        };
      const input = {
        signRequestId: (
          body as Record<string, string>
        ).signRequestId!.toLowerCase(),
        expectedRequestHash: (
          body as Record<string, string>
        ).expectedRequestHash!.toLowerCase(),
      };
      let outcome: Outcome;
      try {
        outcome = await store.run((tx) => process(tx, caller, input));
      } catch (error) {
        // Nothing was committed. The caller keeps its reservation and retries the same request.
        deps.onError?.(error);
        return {
          status: 503,
          body: {
            state: "UNKNOWN",
            code: isRpcUnavailable(error) ? "RPC_UNAVAILABLE" : "SIGNER_ERROR",
          },
        };
      }
      if (outcome.kind === "signed")
        return { status: 200, body: { ...outcome.result } };
      if (outcome.kind === "rejected")
        return { status: 422, body: { state: "REJECTED", code: outcome.code } };
      return {
        status: outcome.status,
        body: { code: outcome.code, message: outcome.code },
      };
    },
  };
}
