# AWS deployment plan (option A: one EC2 host + Docker Compose)

Status: step 1 (AWS access) done on 2026-11-23; nothing is deployed. Drafted 2026-11-23 for a test
deployment paid from AWS credits.
Creating AWS resources, paid services, signing and broadcasting all need explicit approval from the
user first (see `AGENTS.md`); this plan does not grant it.

## Decision

Run the API, worker and indexer as three containers on one EC2 host, with RDS for PostgreSQL 17 as
the database and the domain kept on Cloudflare. This matches the "single application host plus one
managed PostgreSQL" target in [Operations](OPERATIONS.md) and reuses `infra/compose.alpha.yaml` and
`infra/Dockerfile.{api,worker,indexer}`.

- AWS App Runner is not an option: it stopped accepting new customers on 2026-04-30
  ([notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).
- Later, for several hosts, move the same images to ECS Fargate
  ([ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-getting-started.html)
  can front the API).

Topology:

```text
Agent ──HTTPS──> Cloudflare (proxied, Full strict) ──443──> EC2: Caddy ──> API :3001 ──> content dir (EBS)
                                                            EC2: Worker :3002, Indexer :3003 (internal only)
API / Worker / Indexer ──SQL, one login each──> RDS PostgreSQL 17 (private subnet)
API / Worker / Indexer ──RPC──> Base Sepolia (84532)      Agent ──signs its own txs──> Base Sepolia
```

## Inputs to collect

| Item | Used for | Source |
| --- | --- | --- |
| AWS CLI profile `blink` (IAM user `blink-deployer`, see step 1) | AWS CLI | user, per host |
| AWS region: `ap-northeast-1` (decided 2026-11-23) | all resources | decided |
| Credit amount and expiry | instance sizes, budget alerts | user |
| API subdomain on Cloudflare, e.g. `api.<domain>` | `WALLET_BINDING_ORIGIN`, `SPEC_PUBLIC_ORIGIN` (HTTPS required) | user |
| Cloudflare access (dashboard, or an API token scoped to the zone) | DNS record, Origin CA certificate | user |
| Base Sepolia RPC URLs, primary and backup | deploy, API signature checks, indexer, worker alerts | user |
| Deployer wallet with Base Sepolia ETH | `pnpm contracts:deploy --broadcast` only | user |
| Treasury address | `--treasury` of the contract deploy | user |
| Alert webhook (optional) | worker `alert.deliver` | user |
| `BLINK_DEPLOYMENT_ID` | all three services | produced by deploy + register |
| Per-service DB logins | API, worker, indexer, deployment registration | produced in step 3 |

## Steps

1. **AWS access (done 2026-11-23).** Every AWS CLI command in this plan uses `--profile blink`.
   What exists in the account, created in the console by an administrator:

   | Resource | Setting |
   | --- | --- |
   | Budget `blink-test` | Monthly cost budget from the template; email alerts at 85% actual, 100% actual and 100% forecast |
   | IAM role `blink-ec2-ssm` | Trusted entity: EC2. Policy: `AmazonSSMManagedInstanceCore`. Tag `project=blinkmarket`. The console also made an instance profile with the same name, used in step 4 |
   | IAM group `blink-deployers` | AWS managed policies `AmazonEC2FullAccess`, `AmazonRDSFullAccess`, `SecretsManagerReadWrite`, `AmazonSSMFullAccess`, `CloudWatchLogsFullAccess`; inline policy `blink-pass-ec2-role` (below) |
   | IAM user `blink-deployer` | Member of `blink-deployers`; no console access; one access key for the CLI; tag `project=blinkmarket` |

   Inline policy `blink-pass-ec2-role` (`<account-id>` is the 12-digit account ID):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "iam:PassRole",
       "Resource": "arn:aws:iam::<account-id>:role/blink-ec2-ssm",
       "Condition": { "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" } }
     }]
   }
   ```

   The user has no other IAM rights, so `iam:GetRole` and similar reads are denied by design; new
   roles or policies need an administrator. Add `AmazonEC2ContainerRegistryPowerUser` to the group
   only when ECR is used.

   Setting up a new host or device: install AWS CLI v2 (official installer; a user-local install is
   fine), then the person who owns the key runs `aws configure --profile blink` in a terminal on that
   host (region `ap-northeast-1`, output `json`). The key goes only into the AWS shared credentials
   file of that host: never into chat, command arguments, shell history, the repo or logs. Secret
   proxies that substitute a placeholder in HTTP headers do not work here, because the CLI signs
   requests with the secret key (SigV4) instead of sending it. A lost or exposed key is deactivated
   in the console and replaced with a new one. Check the host with
   `aws sts get-caller-identity --profile blink`; the ARN must end in `user/blink-deployer`. For
   `aws ssm start-session` (step 4) the host also needs the Session Manager plugin.
2. **Contracts on Base Sepolia** (not AWS; first broadcast of this tooling to a public network).
   Dry run without a key:
   `DEPLOY_RPC_URL=<rpc> pnpm contracts:deploy -- --params base-sepolia --treasury <addr> --deployment-id <id> --deployer <addr> --out deployments/base-sepolia/<id>.manifest.json`.
   The user then adds `--broadcast` with `DEPLOYER_PRIVATE_KEY`. Check with `pnpm manifest:validate`
   and `pnpm manifest:verify`, then commit the manifest. The key never goes into a service env.
3. **RDS and DB logins.** `aws rds create-db-instance` with engine postgres 17, `db.t4g.micro`, 20 GB
   gp3, `--manage-master-user-password`, `--no-publicly-accessible`, 7-day backups, security group
   open only to the EC2 security group on 5432. From the EC2 host:
   `DATABASE_URL=<owner url> pnpm db:migrate`, then one login per service, as in
   `scripts/images-smoke.ts`:
   `CREATE ROLE <name> LOGIN PASSWORD '<random>' IN ROLE blink_api` (and `blink_worker`,
   `blink_indexer`, `blink_deployment_admin`). Register the deployment:
   `DEPLOYMENT_ADMIN_DATABASE_URL=<deploy login> BASE_SEPOLIA_RPC_URL=<rpc> pnpm deployment:register <manifest> <deployment-id>`.
4. **EC2 host.** `t3.medium` (x86, same as CI), Amazon Linux 2023, 30 GB gp3, instance profile
   `blink-ec2-ssm` from step 1, no port 22 (use `aws ssm start-session`). Security group: 443 from
   Cloudflare IP ranges only. Install Docker with the Compose plugin, git, Node 22 and pnpm; clone the
   repo; `pnpm images:build`. Create a persistent content directory (for example `/srv/blink/specs`)
   owned by the container's `node` user: the S3 adapter is not implemented, so content lives on EBS.
   ECR is not needed until there is more than one host.
5. **Services.** A new compose file based on `infra/compose.alpha.yaml` without postgres and anvil,
   plus Caddy. Secrets in mode-600 env files on the host or from Secrets Manager, never in the repo.

   | Service | Required environment | Exposed |
   | --- | --- | --- |
   | API | `BLINK_API_MODE=markets`, `API_DATABASE_URL`, `BASE_SEPOLIA_RPC_URL`, `BLINK_DEPLOYMENT_ID`, `WALLET_BINDING_ORIGIN=https://api.<domain>`, `SPEC_PUBLIC_ORIGIN=https://api.<domain>`, `SPEC_OBJECT_DIRECTORY=/data/specs`, `API_TRUSTED_PROXIES` | through Caddy only |
   | Worker | `WORKER_ENABLED=true`, `WORKER_DATABASE_URL`, `BLINK_DEPLOYMENT_ID`, `BASE_SEPOLIA_RPC_URL`; optional `ALERT_SINK=webhook`, `ALERT_WEBHOOK_URL` | no |
   | Indexer | `CHAIN_INDEXER_ENABLED=true`, `INDEXER_TX_TRACKING_ENABLED=true`, `INDEXER_DATABASE_URL`, `INDEXER_DEPLOYMENT_ID`, `BASE_SEPOLIA_RPC_URL` | no |

   Run `pnpm deploy:preflight <env-file>` on each env file. Start the indexer first and wait for
   `/health/chain-index` to be fresh (a stale index makes identity-acting API writes return
   `503 INDEX_STALE`), then the worker and API. Run exactly one indexer per deployment (lease owner).
   Use `restart: unless-stopped`.

   `API_TRUSTED_PROXIES`: the path is client → Cloudflare → Caddy → API, so list Caddy's Docker subnet
   plus Cloudflare's published IP ranges (wildcards and whole-internet ranges are rejected). Verify
   after launch that rate limits key on the real client IP.
6. **Cloudflare DNS and HTTPS.** Elastic IP on the instance; Cloudflare `A` record `api` → Elastic IP,
   proxied; SSL/TLS mode Full (strict) with a Cloudflare Origin CA certificate on Caddy. Caddy listens
   on 443 and proxies to `api:3001`; 3002 and 3003 stay on the Docker network. No ALB or ACM.
   `/v1/content/:hash` responses are immutable and may be cached at Cloudflare; add no cache rules for
   other routes.

## Verification, monitoring, backup

- `https://api.<domain>/v1/health` returns 200 and `/v1/deployment` shows the registered deployment.
- Indexer `/health/chain-index` is fresh; worker `/health/jobs` shows no DEAD jobs.
- A reference agent from `examples/agents` (`BLINK_API_URL` = new API, `BLINK_RPC_URL` = Base Sepolia)
  runs a creator and a trader through registration, upload, creation and one RFQ.
- Worker alerts (RPC failure, index lag, DEAD jobs, undistributed fees) reach the webhook.
- Container logs via the Docker `awslogs` driver to CloudWatch Logs, 14-day retention. RDS automated
  backups 7 days; daily EBS snapshots of the content volume (Data Lifecycle Manager). Rehearse one
  restore from an RDS snapshot, then `pnpm chain:rebuild`.

## Known risks (not yet tested)

- Migrations have only run on the official PostgreSQL image. The RDS master user is not a true
  superuser; a migration that needs one would fail in step 3. No migration was found that creates an
  extension or uses `ALTER SYSTEM`.
- RDS for PostgreSQL 15+ forces TLS by default. Connection strings need `sslmode` and the RDS CA bundle;
  confirm node-postgres behaviour on the first connection.
- The contract deploy tooling has only been verified on a local Anvil.

## Cost and cleanup

Ongoing charges: EC2, RDS, EBS, Elastic IP (public IPv4) and CloudWatch Logs. Estimate with the AWS
Pricing Calculator for the chosen region; no prices are recorded here. Tag everything
`project=blinkmarket`. Stopping EC2 and RDS pauses compute charges (RDS restarts itself after 7 days);
disks and the Elastic IP still bill. Teardown order: Cloudflare DNS record → EC2 and Elastic IP → RDS
(keep a final snapshot) → EBS snapshots → CloudWatch log groups.

## Open decisions

- [x] AWS region: `ap-northeast-1`
- [ ] API subdomain name
- [ ] RPC provider (primary and backup)
- [ ] Treasury address and deployment ID
- [ ] Whether the Web docs site moves to AWS (S3 + CloudFront) or stays as is
- [ ] HTTPS through Cloudflare proxy + Origin CA (assumed above) or an AWS ALB + ACM
