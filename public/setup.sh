#!/usr/bin/env bash
set -Eeuo pipefail

CR_USER_NAME="CloudRescueOperator"
CR_ROLE_NAME="CloudRescueAutomationRole"
CR_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CR_CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
CR_PARTITION="$(printf '%s' "$CR_CALLER_ARN" | cut -d: -f2)"

printf '\nCloudRescue AWS 授权配置\n'
printf '账号: %s\n' "$CR_ACCOUNT_ID"

CR_TRUST_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ssm.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$CR_ACCOUNT_ID\"}}}]}"

if aws iam get-role --role-name "$CR_ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "$CR_ROLE_NAME" \
    --policy-document "$CR_TRUST_POLICY" >/dev/null
else
  aws iam create-role \
    --role-name "$CR_ROLE_NAME" \
    --description "Service role for CloudRescue EC2 access recovery" \
    --assume-role-policy-document "$CR_TRUST_POLICY" >/dev/null
fi

aws iam attach-role-policy \
  --role-name "$CR_ROLE_NAME" \
  --policy-arn "arn:$CR_PARTITION:iam::aws:policy/service-role/AmazonSSMAutomationRole" >/dev/null

CR_ROLE_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"EC2RescueFunctions\",\"Effect\":\"Allow\",\"Action\":[\"lambda:CreateFunction\",\"lambda:InvokeFunction\",\"lambda:GetFunction\",\"lambda:DeleteFunction\"],\"Resource\":\"arn:$CR_PARTITION:lambda:*:$CR_ACCOUNT_ID:function:AWSSupport-EC2Rescue-*\"},{\"Sid\":\"OfficialArtifacts\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:GetObjectVersion\"],\"Resource\":[\"arn:$CR_PARTITION:s3:::awssupport-ssm.*/*.template\",\"arn:$CR_PARTITION:s3:::awssupport-ssm.*/*.zip\"]},{\"Sid\":\"TemporaryRescueIdentity\",\"Effect\":\"Allow\",\"Action\":[\"iam:CreateRole\",\"iam:CreateInstanceProfile\",\"iam:GetRole\",\"iam:GetInstanceProfile\",\"iam:PutRolePolicy\",\"iam:DeleteRolePolicy\",\"iam:AttachRolePolicy\",\"iam:DetachRolePolicy\",\"iam:PassRole\",\"iam:AddRoleToInstanceProfile\",\"iam:RemoveRoleFromInstanceProfile\",\"iam:DeleteRole\",\"iam:DeleteInstanceProfile\"],\"Resource\":[\"arn:$CR_PARTITION:iam::$CR_ACCOUNT_ID:role/AWSSupport-EC2Rescue-*\",\"arn:$CR_PARTITION:iam::$CR_ACCOUNT_ID:instance-profile/AWSSupport-EC2Rescue-*\"]},{\"Sid\":\"RescueNetwork\",\"Effect\":\"Allow\",\"Action\":[\"ec2:CreateVpc\",\"ec2:ModifyVpcAttribute\",\"ec2:DeleteVpc\",\"ec2:CreateInternetGateway\",\"ec2:AttachInternetGateway\",\"ec2:DetachInternetGateway\",\"ec2:DeleteInternetGateway\",\"ec2:CreateSubnet\",\"ec2:DeleteSubnet\",\"ec2:CreateRoute\",\"ec2:DeleteRoute\",\"ec2:CreateRouteTable\",\"ec2:AssociateRouteTable\",\"ec2:DisassociateRouteTable\",\"ec2:DeleteRouteTable\",\"ec2:CreateVpcEndpoint\",\"ec2:DeleteVpcEndpoints\",\"ec2:ModifyVpcEndpoint\",\"ec2:Describe*\"],\"Resource\":\"*\"},{\"Sid\":\"EncryptedRootVolume\",\"Effect\":\"Allow\",\"Action\":[\"kms:DescribeKey\",\"kms:CreateGrant\",\"kms:Decrypt\",\"kms:GenerateDataKeyWithoutPlaintext\",\"kms:ReEncryptFrom\",\"kms:ReEncryptTo\"],\"Resource\":\"*\"}]}"

aws iam put-role-policy \
  --role-name "$CR_ROLE_NAME" \
  --policy-name "CloudRescueEC2RescueWorkflow" \
  --policy-document "$CR_ROLE_POLICY" >/dev/null

if ! aws iam get-user --user-name "$CR_USER_NAME" >/dev/null 2>&1; then
  aws iam create-user \
    --user-name "$CR_USER_NAME" \
    --tags Key=ManagedBy,Value=CloudRescue >/dev/null
fi

CR_USER_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DiscoverEC2\",\"Effect\":\"Allow\",\"Action\":[\"ec2:DescribeRegions\",\"ec2:DescribeInstances\",\"ec2:DescribeVolumes\",\"ec2:DescribeAddresses\",\"autoscaling:DescribeAutoScalingInstances\"],\"Resource\":\"*\"},{\"Sid\":\"StartOfficialResetAccess\",\"Effect\":\"Allow\",\"Action\":\"ssm:StartAutomationExecution\",\"Resource\":[\"arn:$CR_PARTITION:ssm:*::document/AWSSupport-ResetAccess\",\"arn:$CR_PARTITION:ssm:*::automation-definition/AWSSupport-ResetAccess:\$DEFAULT\",\"arn:$CR_PARTITION:ssm:*:$CR_ACCOUNT_ID:automation-execution/*\"]},{\"Sid\":\"MonitorRecovery\",\"Effect\":\"Allow\",\"Action\":[\"ssm:GetAutomationExecution\",\"ssm:DescribeAutomationExecutions\",\"ssm:DescribeAutomationStepExecutions\"],\"Resource\":\"arn:$CR_PARTITION:ssm:*:$CR_ACCOUNT_ID:automation-execution/*\"},{\"Sid\":\"ReadGeneratedLinuxKey\",\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameter\",\"Resource\":\"arn:$CR_PARTITION:ssm:*:$CR_ACCOUNT_ID:parameter/ec2rl/openssh/*\"},{\"Sid\":\"PassOnlyCloudRescueRole\",\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:$CR_PARTITION:iam::$CR_ACCOUNT_ID:role/$CR_ROLE_NAME\",\"Condition\":{\"StringEquals\":{\"iam:PassedToService\":\"ssm.amazonaws.com\"}}}]}"

aws iam put-user-policy \
  --user-name "$CR_USER_NAME" \
  --policy-name "CloudRescueOperatorAccess" \
  --policy-document "$CR_USER_POLICY" >/dev/null

CR_KEY_COUNT="$(aws iam list-access-keys --user-name "$CR_USER_NAME" --query 'length(AccessKeyMetadata)' --output text)"
if [ "$CR_KEY_COUNT" -ge 2 ]; then
  printf '\n无法创建新密钥：CloudRescueOperator 已有两个 Access Key。\n' >&2
  printf '请在 IAM 中删除不再使用的旧密钥后重新执行。\n' >&2
  exit 1
fi

read -r CR_ACCESS_KEY_ID CR_SECRET_ACCESS_KEY < <(
  aws iam create-access-key \
    --user-name "$CR_USER_NAME" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' \
    --output text
)

printf '\n配置完成。请把下面两项复制到 CloudRescue 网页：\n\n'
printf 'Access Key ID:     %s\n' "$CR_ACCESS_KEY_ID"
printf 'Secret Access Key: %s\n\n' "$CR_SECRET_ACCESS_KEY"
printf '安全提示：Secret Access Key 仅显示这一次。任务完成后请在 IAM 中禁用或删除。\n'
