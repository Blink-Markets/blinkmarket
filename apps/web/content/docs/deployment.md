---
title: Deployment
description: The Blink contracts deployed on Base Sepolia, their role addresses, and how to check them.
group: Reference
order: 4
agentTask: find the deployed Blink contract and role addresses and check them against the chain
---

# Deployment

> [!NOTE]
> **v0.1 deployment record.** This page describes the `alpha-2` contracts, the old v0.1 design with fixed roles and trading disabled, kept as history. No P1 generation has been deployed to any network, and `alpha-2` is no longer the target deployment.

The contracts were deployed on Base Sepolia (chain ID 84532) on 2026-10-20 as deployment `alpha-2`. Trading is disabled (`tradingEnabled: false`), no markets have been created, the API, worker, indexer and signer are not deployed, and there is no public API host. Nothing trades on this site; bUSD has no value.

## Which contracts are deployed?

| Contract | Address | Purpose |
| --- | --- | --- |
| BlinkTestUSD | [0x6A656a6576DFfB6697754E378B3f8d620c7250FC](https://sepolia.basescan.org/address/0x6A656a6576DFfB6697754E378B3f8d620c7250FC) | Test collateral token for Base Sepolia. |
| BlinkMarket | [0x0936fDce1aCB72c88a786250b5454094068D41b9](https://sepolia.basescan.org/address/0x0936fDce1aCB72c88a786250b5454094068D41b9) | Holds market configuration and collateral, and enforces trading and settlement. |

## Which role addresses are fixed?

| Role | Address |
| --- | --- |
| [Admin](/docs/roles) | [0xdc9a78D773784B9B01D445816669d50DE9C66439](https://sepolia.basescan.org/address/0xdc9a78D773784B9B01D445816669d50DE9C66439) |
| [Result proposer](/docs/roles) | [0x771AA52b590e13EBA60f8d28695323c3079cA80e](https://sepolia.basescan.org/address/0x771AA52b590e13EBA60f8d28695323c3079cA80e) |
| [Challenger](/docs/roles) | [0x896abDa2920423735cE1b6ddFFBf161b9DA71b71](https://sepolia.basescan.org/address/0x896abDa2920423735cE1b6ddFFBf161b9DA71b71) |
| [Arbiter](/docs/roles) | [0x0950bF36ef320beA22A18a152fdB744e78798150](https://sepolia.basescan.org/address/0x0950bF36ef320beA22A18a152fdB744e78798150) |
| [Maker](/docs/roles) | [0x4bf0e533BE7E8D3cd1c7771c933078d45D69C964](https://sepolia.basescan.org/address/0x4bf0e533BE7E8D3cd1c7771c933078d45D69C964) |
| [Faucet minter](/docs/roles) | [0x0893b6010E2E352db85e72FEC6FeD4F3beE18ae5](https://sepolia.basescan.org/address/0x0893b6010E2E352db85e72FEC6FeD4F3beE18ae5) |

The keeper needs no address because anyone may finalize; the internal trader's wallet is not part of the manifest.

## What are the deployment details?

| Detail | Value |
| --- | --- |
| Deployment block | `48371702` |
| Git commit | `0ae8f36785d7dde4bdc5eadc4155462ab210392a` |
| Compiler | `0.8.30` |

| Parameter | Value |
| --- | --- |
| `collateralDecimals` | `6` |
| `quoteDefaultTtlSeconds` | `30` |
| `quoteMaxTtlSeconds` | `60` |
| `makerSpreadBps` | `200` |
| `maxFillShares` | `100` |
| `maxMarketPairs` | `10000` |
| `maxTakerShares` | `500` |

## How do I check it?

The manifest is at [/deployments/base-sepolia/alpha-2.manifest.json](/deployments/base-sepolia/alpha-2.manifest.json) on this site and at `deployments/base-sepolia/alpha-2.manifest.json` in the repository. The repository's [deployment tooling notes](https://github.com/Blink-Markets/blinkmarket/blob/main/docs/M5_DEPLOYMENT_TOOLING.md) describe the read-only verifier that checks a manifest against the chain.

Both contracts' source code is verified on Sourcify with an exact match (creation and runtime bytecode, including metadata): [BlinkTestUSD](https://repo.sourcify.dev/84532/0x6A656a6576DFfB6697754E378B3f8d620c7250FC) and [BlinkMarket](https://repo.sourcify.dev/84532/0x0936fDce1aCB72c88a786250b5454094068D41b9). Compare the addresses on this page with the explorer and with Sourcify.

## What about other addresses?

An earlier attempt (`alpha-1`) left an unused BlinkTestUSD at `0x83517271696F7420296EDD7872BC50C5B83141A8`; it is not part of any deployment. Agents must not use this address.

## Hand it to your agent

```prompt
Read https://blink-markets.github.io/blinkmarket/docs/deployment.md, list the contract and role addresses, and check them on the explorer and on Sourcify. Base Sepolia testnet only (chain ID 84532); bUSD has no value. Do not create wallets, request keys, or sign or broadcast transactions unless the operator explicitly asks.
```
