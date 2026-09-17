export const MFA_OPERATOR_ACCOUNT_ID = '590184009438';
export const MFA_TARGET_ROLE_NAME = 'MfaRecoveryTargetRole';
export const MFA_TARGET_POLICY_NAME = 'MfaRecoveryPermissions';

export function targetRoleArn(accountId) {
  return `arn:aws:iam::${accountId}:role/${MFA_TARGET_ROLE_NAME}`;
}

export function createPayerRolePowerShellCommand() {
  return `$ErrorActionPreference = 'Stop'
$RoleName = '${MFA_TARGET_ROLE_NAME}'
$PolicyName = '${MFA_TARGET_POLICY_NAME}'
$TrustedAccountId = '${MFA_OPERATOR_ACCOUNT_ID}'

$CurrentAccountId = aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0 -or $CurrentAccountId -notmatch '^\\d{12}$') {
  throw 'Unable to identify the current AWS account. Check your AWS CLI login.'
}

$Organization = aws organizations describe-organization --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
  throw 'Run this command in the AWS Organizations management account.'
}
$ManagementAccountId = if ($Organization.Organization.ManagementAccountId) {
  $Organization.Organization.ManagementAccountId
} else {
  $Organization.Organization.MasterAccountId
}
if ($CurrentAccountId -ne $ManagementAccountId) {
  throw "Current account $CurrentAccountId is not the Organizations management account $ManagementAccountId."
}

$TrustPolicy = @{
  Version = '2012-10-17'
  Statement = @(
    @{
      Effect = 'Allow'
      Principal = @{ AWS = ('arn:aws:iam::' + $TrustedAccountId + ':root') }
      Action = 'sts:AssumeRole'
    }
  )
} | ConvertTo-Json -Depth 10 -Compress

$PermissionsPolicy = @{
  Version = '2012-10-17'
  Statement = @(
    @{
      Sid = 'ReadOrganizationState'
      Effect = 'Allow'
      Action = @(
        'organizations:DescribeOrganization',
        'organizations:DescribeAccount',
        'organizations:ListAWSServiceAccessForOrganization',
        'organizations:ListDelegatedAdministrators',
        'iam:ListOrganizationsFeatures'
      )
      Resource = '*'
    },
    @{
      Sid = 'EnableRequiredTrustedServices'
      Effect = 'Allow'
      Action = 'organizations:EnableAWSServiceAccess'
      Resource = '*'
      Condition = @{
        StringEquals = @{
          'organizations:ServicePrincipal' = @(
            'iam.amazonaws.com',
            'account.amazonaws.com'
          )
        }
      }
    },
    @{
      Sid = 'ConfigureCentralizedRootAccess'
      Effect = 'Allow'
      Action = @(
        'iam:EnableOrganizationsRootCredentialsManagement',
        'iam:EnableOrganizationsRootSessions'
      )
      Resource = '*'
    },
    @{
      Sid = 'AssumeRecoveryRootSessions'
      Effect = 'Allow'
      Action = 'sts:AssumeRoot'
      Resource = 'arn:aws:iam::*:root'
      Condition = @{
        ArnEquals = @{
          'sts:TaskPolicyArn' = @(
            'arn:aws:iam::aws:policy/root-task/IAMAuditRootUserCredentials',
            'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials',
            'arn:aws:iam::aws:policy/root-task/IAMCreateRootUserPassword'
          )
        }
      }
    },
    @{
      Sid = 'ChangeMemberRootEmail'
      Effect = 'Allow'
      Action = @(
        'account:StartPrimaryEmailUpdate',
        'account:AcceptPrimaryEmailUpdate',
        'account:GetPrimaryEmail',
        'iam:UpdateAccountEmailAddress'
      )
      Resource = '*'
    },
    @{
      Sid = 'CleanupIamDelegatedAdministrator'
      Effect = 'Allow'
      Action = 'organizations:DeregisterDelegatedAdministrator'
      Resource = '*'
      Condition = @{
        StringEquals = @{
          'organizations:ServicePrincipal' = 'iam.amazonaws.com'
        }
      }
    }
  )
} | ConvertTo-Json -Depth 20 -Compress

$TrustFile = Join-Path ([System.IO.Path]::GetTempPath()) 'mfa-recovery-trust.json'
$PolicyFile = Join-Path ([System.IO.Path]::GetTempPath()) 'mfa-recovery-permissions.json'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

try {
  [System.IO.File]::WriteAllText($TrustFile, $TrustPolicy, $Utf8NoBom)
  [System.IO.File]::WriteAllText($PolicyFile, $PermissionsPolicy, $Utf8NoBom)

  aws iam get-role --role-name $RoleName *> $null
  if ($LASTEXITCODE -eq 0) {
    aws iam update-assume-role-policy --role-name $RoleName --policy-document "file://$TrustFile"
  } else {
    aws iam create-role --role-name $RoleName --description 'MFA Recovery cross-account role' --assume-role-policy-document "file://$TrustFile" *> $null
  }
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create or update the trusted role.' }

  aws iam put-role-policy --role-name $RoleName --policy-name $PolicyName --policy-document "file://$PolicyFile"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to attach the MFA Recovery permissions.' }

  $RoleArn = aws iam get-role --role-name $RoleName --query Role.Arn --output text
  if ($LASTEXITCODE -ne 0) { throw 'Failed to verify the trusted role.' }
  Write-Host "MFA Recovery role is ready: $RoleArn" -ForegroundColor Green
  Write-Host "Return to the website and enter management account ID: $CurrentAccountId" -ForegroundColor Cyan
} finally {
  Remove-Item $TrustFile, $PolicyFile -Force -ErrorAction SilentlyContinue
}
`;
}
