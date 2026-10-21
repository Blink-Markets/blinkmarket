-- tx.dispatch waits on Base Sepolia finality, which trailed by up to 33 minutes: it needs 20 attempts.
ALTER TABLE operations.jobs DROP CONSTRAINT jobs_max_attempts_check,
  ADD CONSTRAINT jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 20);
