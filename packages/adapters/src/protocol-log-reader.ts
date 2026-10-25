import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import {
  MarketStateName,
  OutcomeName,
  ClassName,
  RoleName,
  type ProtocolDeployment,
} from "@blink/schemas";
import {
  creditAt,
  hasRole,
  type ChainBlock,
  type ChainLogReader,
  type ProtocolEvent,
  type ProtocolProjection,
} from "@blink/ports";
import { protocolAbi, type ProtocolContractName } from "./protocol-abi.js";
const abiByContract = protocolAbi as unknown as Record<
  ProtocolContractName,
  Abi
>;
const causes = (error: unknown): unknown[] => {
  const list: unknown[] = [];
  for (
    let e = error;
    e && list.length < 8;
    e = (e as { cause?: unknown }).cause
  )
    list.push(e);
  return list;
};
const named = (error: unknown, name: string) =>
  causes(error).some((e) => (e as Error).name === name);
const unsupported = (error: unknown) =>
  causes(error).some((e) =>
    [-32601, -32602, -32004].includes((e as { code?: number }).code ?? 0),
  ) || named(error, "BlockNotFoundError");
function normalize(
  value: unknown,
  type: string,
): ProtocolEvent["args"][string] {
  if (Array.isArray(value))
    return value.map((v) => normalize(v, type.replace(/\[\d*\]$/, "")));
  if (typeof value === "bigint" || typeof value === "number")
    return value.toString();
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return type === "address" || type.startsWith("bytes")
      ? value.toLowerCase()
      : value;
  throw new Error("CHAIN_LOG_UNDECODABLE");
}
export function protocolLogReader(
  client: PublicClient,
  deployment: ProtocolDeployment,
): ChainLogReader {
  const addresses = new Map<
    string,
    { contract: ProtocolEvent["contract"]; abi: Abi }
  >();
  for (const key of [
    "registry",
    "jurors",
    "markets",
    "resolution",
    "faucet",
    "anchor",
    "governor",
  ] as const) {
    const address =
      key in deployment.generation
        ? deployment.generation[
            key as "registry" | "jurors" | "markets" | "resolution"
          ]
        : deployment.shared[key as "faucet" | "anchor" | "governor"];
    addresses.set(address.toLowerCase(), {
      contract: key.toUpperCase() as ProtocolEvent["contract"],
      abi: abiByContract[key],
    });
  }
  const header = (b: {
    number: bigint | null;
    hash: Hex | null;
    parentHash: Hex;
    timestamp: bigint;
  }): ChainBlock => {
    if (b.number === null || b.hash === null)
      throw new Error("CHAIN_BLOCK_PENDING");
    return {
      number: b.number,
      hash: b.hash.toLowerCase(),
      parentHash: b.parentHash.toLowerCase(),
      timestamp: b.timestamp,
    };
  };
  const read = async (
    contract: ProtocolContractName,
    functionName: string,
    args: readonly unknown[],
    blockHash: string,
  ) => {
    const address =
      contract in deployment.generation
        ? deployment.generation[
            contract as "registry" | "jurors" | "markets" | "resolution"
          ]
        : deployment.shared[contract as keyof ProtocolDeployment["shared"]];
    const data = encodeFunctionData({
      abi: abiByContract[contract],
      functionName,
      args,
    });
    const result = await client.request({
      method: "eth_call",
      params: [
        { to: address as Hex, data },
        { blockHash: blockHash as Hex, requireCanonical: true },
      ],
    });
    return decodeFunctionResult({
      abi: abiByContract[contract],
      functionName,
      data: result,
    }) as unknown;
  };
  return {
    chainId: () => client.getChainId(),
    async head() {
      return header(await client.getBlock({ blockTag: "latest" }));
    },
    async finalized() {
      try {
        return header(await client.getBlock({ blockTag: "finalized" })).number;
      } catch (e) {
        if (unsupported(e)) return null;
        throw e;
      }
    },
    async block(number) {
      try {
        return header(await client.getBlock({ blockNumber: number }));
      } catch (e) {
        if (named(e, "BlockNotFoundError")) return null;
        throw e;
      }
    },
    async logs(_address, from, to) {
      const logs = await client.getLogs({
        address: [...addresses.keys()] as Hex[],
        fromBlock: from,
        toBlock: to,
      });
      const events: ProtocolEvent[] = [];
      const timestamps = new Map<string, bigint>();
      for (const log of logs) {
        if (log.removed) throw new Error("CHAIN_LOG_REMOVED");
        if (
          log.blockHash === null ||
          log.blockNumber === null ||
          log.transactionHash === null ||
          log.transactionIndex === null ||
          log.logIndex === null
        )
          throw new Error("CHAIN_LOG_PENDING");
        const source = addresses.get(log.address.toLowerCase());
        if (!source) throw new Error("CHAIN_LOG_FOREIGN_ADDRESS");
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: source.abi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
        } catch {
          throw new Error("CHAIN_LOG_UNDECODABLE");
        }
        const blockHash = log.blockHash.toLowerCase();
        if (!timestamps.has(blockHash))
          timestamps.set(
            blockHash,
            header(await client.getBlock({ blockHash: log.blockHash }))
              .timestamp,
          );
        events.push({
          contract: source.contract,
          emitter: log.address.toLowerCase(),
          name: decoded.eventName!,
          args: Object.fromEntries(
            source.abi
              .filter(
                (item) =>
                  item.type === "event" && item.name === decoded.eventName,
              )
              .flatMap((item) =>
                item.type === "event"
                  ? item.inputs.map((input) => [
                      input.name!,
                      normalize(
                        (decoded.args as unknown as Record<string, unknown>)[
                          input.name!
                        ],
                        input.type,
                      ),
                    ])
                  : [],
              ),
          ) as ProtocolEvent["args"],
          blockNumber: log.blockNumber,
          blockHash,
          blockTimestamp: timestamps.get(blockHash)!,
          txHash: log.transactionHash.toLowerCase(),
          txIndex: log.transactionIndex,
          logIndex: log.logIndex,
        });
      }
      return events;
    },
    async agrees(blockHash, p: ProtocolProjection, events) {
      const touched = (
        contract: ProtocolEvent["contract"],
        key: string,
        value: string,
      ) =>
        events === undefined ||
        events.some((e) => e.contract === contract && e.args[key] === value);
      const checks: (() => Promise<boolean>)[] = [];
      const block = header(
        await client.getBlock({ blockHash: blockHash as Hex }),
      );
      const timestamp = Number(block.timestamp);
      const deployed = (name: string) =>
        block.number >=
        BigInt(deployment.contracts[name]?.block ?? deployment.startBlock);
      if (
        !deployed("BlinkMarkets") &&
        (p.markets.size ||
          p.templates.size ||
          p.positions.size ||
          p.makers.size ||
          p.digests.size ||
          p.fills.size)
      )
        return false;
      if (!deployed("BlinkRegistry") && p.accounts.size) return false;
      if (!deployed("BlinkAnchor") && p.anchors.size) return false;
      const mread = (fn: string, args: readonly unknown[]) =>
        read("markets", fn, args, blockHash);
      for (const m of p.markets.values()) {
        if (!touched("MARKETS", "marketId", m.marketId)) continue;
        checks.push(async () => {
          const v = (await mread("getMarket", [BigInt(m.marketId)])) as Record<
            string,
            unknown
          >;
          if (
            String(v.creator).toLowerCase() !== m.creator ||
            ClassName.options[Number(v.cls)] !== m.class ||
            MarketStateName.options[Number(v.state)] !== m.state ||
            String(v.templateId).toLowerCase() !== m.templateId ||
            String(v.specHash).toLowerCase() !== m.specHash ||
            v.replay !== m.replay ||
            Number(v.openAt) !== m.openAt ||
            Number(v.closeAt) !== m.closeAt ||
            Number(v.proposalDeadline) !== m.proposalDeadline ||
            Number(v.hardDeadline) !== m.hardDeadline ||
            String(v.maxPairs) !== m.maxPairs ||
            String(v.totalMintedPairs) !== m.mintedPairs ||
            String(v.escrowMicros) !== m.escrowMicros ||
            v.creationChallenged !== m.creationChallenged ||
            v.feesDistributed !== m.feesDistributed
          )
            return false;
          if (
            m.state === "FINAL" &&
            OutcomeName.options[Number(v.finalOutcome)] !== m.finalOutcome
          )
            return false;
          if (
            String(await mread("feePool", [BigInt(m.marketId)])) !==
            m.feePoolMicros
          )
            return false;
          return true;
        });
      }
      // The count catches missing creation logs during creation batches and full rebuild audits.
      if (
        deployed("BlinkMarkets") &&
        (events === undefined ||
          events.some(
            (e) => e.contract === "MARKETS" && e.name === "MarketCreated",
          ))
      )
        checks.push(
          async () =>
            BigInt((await mread("nextMarketId", [])) as bigint) ===
            BigInt(p.markets.size) + 1n,
        );
      for (const pos of p.positions.values()) {
        if (
          events !== undefined &&
          !events.some(
            (e) =>
              e.contract === "MARKETS" &&
              e.args.marketId === pos.marketId &&
              [e.args.account, e.args.maker, e.args.taker].includes(
                pos.account,
              ),
          )
        )
          continue;
        checks.push(async () => {
          const v = (await mread("getPosition", [
            BigInt(pos.marketId),
            pos.account,
          ])) as readonly bigint[];
          if (
            String(v[0]) !== pos.yesShares ||
            String(v[1]) !== pos.noShares ||
            String(
              await mread("cumulativeTakerShares", [
                BigInt(pos.marketId),
                pos.account,
              ]),
            ) !== pos.takerBoughtShares
          )
            return false;
          return true;
        });
      }
      for (const m of p.makers.values()) {
        if (!touched("MARKETS", "maker", m.address)) continue;
        checks.push(
          async () =>
            String(await mread("makerFree", [m.address])) === m.freeMicros &&
            String(await mread("makerEpoch", [m.address])) === m.epoch,
        );
      }
      for (const [d, status] of p.digests) {
        if (!touched("MARKETS", "digest", d)) continue;
        checks.push(
          async () =>
            Boolean(await mread("consumed", [d])) === (status === "CONSUMED") &&
            Boolean(await mread("cancelled", [d])) === (status === "CANCELLED"),
        );
      }
      for (const a of p.accounts.values()) {
        if (!touched("REGISTRY", "account", a.address)) continue;
        checks.push(async () => {
          if (
            (await read("registry", "isRegistered", [a.address], blockHash)) !==
            a.registered
          )
            return false;
          for (const [i, role] of RoleName.options.entries()) {
            if (
              (await read("registry", "hasRole", [a.address, i], blockHash)) !==
                hasRole(a, role, deployment.params.minRoleStake) ||
              Number(
                await read("registry", "creditOf", [a.address, i], blockHash),
              ) !==
                creditAt(
                  a.credit[role],
                  timestamp,
                  deployment.params.creditHalfLife,
                )
            )
              return false;
            if (
              role !== "JUROR" &&
              String(
                await read("registry", "roleStake", [a.address, i], blockHash),
              ) !== a.roles[role].stakeMicros
            )
              return false;
          }
          return true;
        });
      }
      for (const a of p.anchors.values()) {
        if (!touched("ANCHOR", "root", a.root)) continue;
        checks.push(
          async () =>
            Number(await read("anchor", "anchoredAt", [a.root], blockHash)) ===
            a.anchoredAt,
        );
      }
      if (
        deployed("BlinkGovernor") &&
        (events === undefined ||
          events.some(
            (e) => e.contract === "GOVERNOR" && e.name === "SuccessorAdopted",
          ))
      ) {
        checks.push(async () => {
          const registry = String(
            await read("governor", "pendingSuccessor", [], blockHash),
          ).toLowerCase();
          const effectiveAt = Number(
            await read("governor", "successorEffectiveAt", [], blockHash),
          );
          return /^0x0{40}$/.test(registry)
            ? p.successors.size === 0
            : p.successors.get(registry)?.effectiveAt === effectiveAt;
        });
      } else if (!deployed("BlinkGovernor") && p.successors.size) return false;
      // Eight workers bound in-flight eth_calls, including full rebuild audits.
      let next = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(8, checks.length) }, async () => {
          while (next < checks.length) {
            const check = checks[next++]!;
            if (!(await check())) return false;
          }
          return true;
        }),
      );
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      return results.every((r) => r.status === "fulfilled" && r.value);
    },
  };
}
