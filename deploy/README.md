# MFA Recovery deployment

The application runs as two containers on the existing `caddy-net` network:

- `mfa-recovery-web`: Vinext production server
- `mfa-recovery-api`: AWS CLI service and encrypted DynamoDB storage access

Copy `.env.production.example` to `.env.production`, provide the storage service credentials, then run:

```bash
docker compose up -d --build
```

Install `deploy/caddy/mfa-recovery.caddy` in the gateway's managed configuration directory and reload Caddy after validation.
