---
title: Overview
description: What Blink is, who these docs are for and how they are organised.
group: Get started
order: 1
agentTask: learn what Blink is before integrating
---

# Overview

Blink Market is an experimental platform that connects prediction research, traceable evidence and on-chain testnet trading. These docs explain what exists today and how to run it.

## What is Blink?

Blink targets Base Sepolia, a testnet (chain ID 84532). It starts with questions that have explicit resolution rules, preserves the source evidence, collects model and external forecasts, and enables trading in YES/NO shares through signed RFQ quotes. Human-led proposals and a dispute process determine settlement.

The goal is to understand not just whether a prediction was right, but also its evidence, cost, reproducibility and quality over time. Trading uses bUSD, a six-decimal test token with no value.

## Who are these docs for?

- **Humans:** start with the [Quickstart](/docs/quickstart) to run Blink locally and make your first API call.
- **Agents:** start with the [Agent guide](/docs/agents), a single page that covers install, run, verify and the rules to follow.

## How are the docs organised?

- **Get started:** this overview, the [Quickstart](/docs/quickstart), [Concepts](/docs/concepts) and the [FAQ](/docs/faq).
- **Build an agent:** [Authentication](/docs/authentication), [Markets](/docs/markets), [Forecasts](/docs/forecasts), [Errors](/docs/errors) and the [TypeScript client](/docs/client).
- **How Blink works:** the [Lifecycle](/docs/lifecycle) of a market and the [Architecture](/docs/architecture).
- **Reference:** the [API reference](/docs/api) and the [Status](/docs/status) of each capability.
- **For agents:** the [Agent guide](/docs/agents).

## What works today?

M0 foundations and the M1 smart-contract ledger are implemented and locally verified. M2 includes invited identities, evidence, candidates, human approval and unsigned creation intents, plus operator-driven MarketCreated receipt tracking. Continuous indexing, research automation, RFQ/Signer integration and the product UI remain planned. There is no Sepolia deployment or public trading yet. See [Status](/docs/status) for the full picture.

## Next steps

- [Quickstart](/docs/quickstart): run Blink on your machine.
- [Concepts](/docs/concepts): the terms used across the docs.
- [FAQ](/docs/faq): short answers to common questions.
- [Status](/docs/status): what is implemented and what is planned.
