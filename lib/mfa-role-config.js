export const MFA_OPERATOR_ACCOUNT_ID = '590184009438';
export const MFA_TARGET_ROLE_NAME = 'MfaRecoveryTargetRole';
export const MFA_TARGET_POLICY_NAME = 'MfaRecoveryPermissions';

export function targetRoleArn(accountId) {
  return `arn:aws:iam::${accountId}:role/${MFA_TARGET_ROLE_NAME}`;
}

export function createPayerRoleCloudShellCommand() {
  return `set -euo pipefail

ROLE_NAME='${MFA_TARGET_ROLE_NAME}'
POLICY_NAME='${MFA_TARGET_POLICY_NAME}'
TRUSTED_ACCOUNT_ID='${MFA_OPERATOR_ACCOUNT_ID}'

CURRENT_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "$CURRENT_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo 'Unable to identify the current AWS account. Check your CloudShell login.' >&2
  exit 1
fi

MANAGEMENT_ACCOUNT_ID="$(aws organizations describe-organization --query 'Organization.ManagementAccountId' --output text)"
if [[ -z "$MANAGEMENT_ACCOUNT_ID" || "$MANAGEMENT_ACCOUNT_ID" == 'None' ]]; then
  MANAGEMENT_ACCOUNT_ID="$(aws organizations describe-organization --query 'Organization.MasterAccountId' --output text)"
fi
if [[ "$CURRENT_ACCOUNT_ID" != "$MANAGEMENT_ACCOUNT_ID" ]]; then
  echo "Run this command in the AWS Organizations management account ($MANAGEMENT_ACCOUNT_ID)." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
TRUST_FILE="$TMP_DIR/trust.json"
POLICY_FILE="$TMP_DIR/permissions.json"
cleanup() {
  rm -f "$TRUST_FILE" "$POLICY_FILE"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

cat > "$TRUST_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::$TRUSTED_ACCOUNT_ID:root"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

cat > "$POLICY_FILE" <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOrganizationState",
      "Effect": "Allow",
      "Action": [
        "organizations:DescribeOrganization",
        "organizations:DescribeAccount",
        "organizations:ListAWSServiceAccessForOrganization",
        "organizations:ListDelegatedAdministrators",
        "iam:ListOrganizationsFeatures"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EnableRequiredTrustedServices",
      "Effect": "Allow",
      "Action": "organizations:EnableAWSServiceAccess",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "organizations:ServicePrincipal": [
            "iam.amazonaws.com",
            "account.amazonaws.com"
          ]
        }
      }
    },
    {
      "Sid": "ConfigureCentralizedRootAccess",
      "Effect": "Allow",
      "Action": [
        "iam:EnableOrganizationsRootCredentialsManagement",
        "iam:EnableOrganizationsRootSessions"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AssumeRecoveryRootSessions",
      "Effect": "Allow",
      "Action": "sts:AssumeRoot",
      "Resource": "arn:aws:iam::*:root",
      "Condition": {
        "ArnEquals": {
          "sts:TaskPolicyArn": [
            "arn:aws:iam::aws:policy/root-task/IAMAuditRootUserCredentials",
            "arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials",
            "arn:aws:iam::aws:policy/root-task/IAMCreateRootUserPassword"
          ]
        }
      }
    },
    {
      "Sid": "ChangeMemberRootEmail",
      "Effect": "Allow",
      "Action": [
        "account:StartPrimaryEmailUpdate",
        "account:AcceptPrimaryEmailUpdate",
        "account:GetPrimaryEmail",
        "iam:UpdateAccountEmailAddress"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CleanupIamDelegatedAdministrator",
      "Effect": "Allow",
      "Action": "organizations:DeregisterDelegatedAdministrator",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "organizations:ServicePrincipal": "iam.amazonaws.com"
        }
      }
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \\
    --role-name "$ROLE_NAME" \\
    --policy-document "file://$TRUST_FILE"
else
  aws iam create-role \\
    --role-name "$ROLE_NAME" \\
    --description 'MFA Recovery cross-account role' \\
    --assume-role-policy-document "file://$TRUST_FILE" >/dev/null
fi

aws iam put-role-policy \\
  --role-name "$ROLE_NAME" \\
  --policy-name "$POLICY_NAME" \\
  --policy-document "file://$POLICY_FILE"

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"
echo "MFA Recovery role is ready: $ROLE_ARN"
echo "Return to the website and enter management account ID: $CURRENT_ACCOUNT_ID"
`;
}
