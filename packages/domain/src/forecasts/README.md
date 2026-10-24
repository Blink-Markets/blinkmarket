# Forecasts and baselines

Responsibility: Two internal forecasters, an independent baseline, external agents and window sealing.

Data ownership: forecast_windows / forecasts / model_runs

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/forecasts/` and external adapters in `packages/adapters/src/forecasts/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
