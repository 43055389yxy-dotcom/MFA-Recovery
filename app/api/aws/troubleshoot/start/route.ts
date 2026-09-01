import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { StartAutomationExecutionCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  errorResponse,
  partitionForRegion,
  targetSchema,
  toCredentials,
} from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const input = targetSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const [identity, described] = await Promise.all([
      new STSClient({ region: input.region, credentials, maxAttempts: 2 }).send(
        new GetCallerIdentityCommand({}),
      ),
      new EC2Client({ region: input.region, credentials, maxAttempts: 2 }).send(
        new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }),
      ),
    ]);
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error('没有找到该 EC2 实例。');
    const accountId = identity.Account;
    if (!accountId) throw new Error('无法识别 AWS Account ID。');

    const platform: 'Linux' | 'Windows' =
      instance.Platform === 'Windows' ? 'Windows' : 'Linux';
    const documentName =
      platform === 'Windows'
        ? 'AWSSupport-TroubleshootRDP'
        : 'AWSSupport-TroubleshootSSH';
    const roleArn = `arn:${partitionForRegion(input.region)}:iam::${accountId}:role/CloudRescueAutomationRole`;
    const parameters: Record<string, string[]> =
      platform === 'Windows'
        ? {
            InstanceId: [input.instanceId],
            AutomationAssumeRole: [roleArn],
            Action: ['Custom'],
            AllowOffline: ['false'],
            Firewall: ['Check'],
            RDPServiceStartupType: ['Auto'],
            RDPServiceAction: ['Start'],
            RDPPortAction: ['Modify'],
            NLASettingAction: ['Check'],
            RemoteConnections: ['Enable'],
          }
        : {
            InstanceId: [input.instanceId],
            AutomationAssumeRole: [roleArn],
            Action: ['FixAll'],
            AllowOffline: ['false'],
          };

    const response = await new SSMClient({
      region: input.region,
      credentials,
      maxAttempts: 2,
    }).send(
      new StartAutomationExecutionCommand({
        DocumentName: documentName,
        DocumentVersion: '$DEFAULT',
        ClientToken: crypto.randomUUID(),
        Parameters: parameters,
        Tags: [
          { Key: 'StartedBy', Value: 'CloudRescue' },
          { Key: 'RecoveryMode', Value: 'OnlineOnly' },
          { Key: 'TargetInstance', Value: input.instanceId },
        ],
      }),
    );

    return Response.json({
      ok: true,
      run: {
        id: response.AutomationExecutionId || '',
        kind: 'automation',
        strategy: 'online-troubleshoot',
        documentName,
        platform,
        instanceId: input.instanceId,
        region: input.region,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
