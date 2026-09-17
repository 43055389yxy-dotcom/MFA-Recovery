# MFA Recovery deployment

The application runs as one `mfa-recovery` container on the existing `caddy-net` network. The container serves the Vinext application on port 3000 and the AWS API service on port 3198.

Grant the host IAM role access to the DynamoDB table and permission to assume
the customer onboarding role. The application no longer stores customer
AK/SK credentials; it uses the host role to request temporary cross-account
sessions.

Attach this statement to the EC2 instance role (or the ECS task/Lambda
execution role) in operator account `590184009438`:

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": "arn:aws:iam::*:role/MfaRecoveryTargetRole"
}
```

Customer onboarding creates `MfaRecoveryTargetRole` in the customer's AWS
Organizations management account and trusts operator account `590184009438`.
Only the minimum MFA recovery permissions are attached to that role.

Copy `.env.production.example` to `.env.production`, then run:

```bash
docker compose up -d --build
```

Install `deploy/caddy/mfa-recovery.caddy` in the gateway's managed configuration directory and reload Caddy after validation.
