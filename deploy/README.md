# MFA Recovery deployment

The application runs as one `mfa-recovery` container on the existing `caddy-net` network. The container serves the Vinext application on port 3000 and the AWS API service on port 3198.

Grant the host IAM role access to the DynamoDB table and KMS key, copy `.env.production.example` to `.env.production`, then run:

```bash
docker compose up -d --build
```

Install `deploy/caddy/mfa-recovery.caddy` in the gateway's managed configuration directory and reload Caddy after validation.
