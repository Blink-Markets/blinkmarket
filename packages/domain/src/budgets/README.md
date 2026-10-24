# Cost and budgets

Responsibility: USD micro-units, atomic reservations and keeping unknown costs.

Data ownership: question_budgets / daily_budgets / cost_entries

Status: Module location and boundary are established; use cases / repositories are not yet implemented.

Later domain models go in this directory; application use cases go in `packages/application/src/budgets/` and external adapters in `packages/adapters/src/budgets/`. Other modules must not write this module's tables directly; cross-module updates go through application orchestration, one transaction and the outbox.
