import { StartAutomationExecutionCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';

import {
  errorResponse,
  partitionForRegion,
  targetSchema,
  toCredentials,
} from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const startSchema = targetSchema.extend({
  encrypted: z.boolean().default(false),
  confirmed: z.literal(true),
});

export async function POST(request: Request) {
  try {
    const input = startSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const identity = await new STSClient({ region: input.region, credentials, maxAttempts: 2 }).send(
      new GetCallerIdentityCommand({}),
    );
    const accountId = identity.Account;
    if (!accountId) throw new Error('无法识别 AWS Account ID');

    const partition = partitionForRegion(input.region);
    const automationRole = `arn:${partition}:iam::${accountId}:role/CloudRescueAutomationRole`;
    const client = new SSMClient({ region: input.region, credentials, maxAttempts: 2 });
    const response = await client.send(
      new StartAutomationExecutionCommand({
        DocumentName: 'AWSSupport-ResetAccess',
        DocumentVersion: '$DEFAULT',
        ClientToken: crypto.randomUUID(),
        Parameters: {
          InstanceId: [input.instanceId],
          AutomationAssumeRole: [automationRole],
          EC2RescueInstanceType: ['t3.medium'],
          SubnetId: ['CreateNewVPC'],
          AllowEncryptedVolume: [input.encrypted ? 'True' : 'False'],
          AssociatePublicIpAddress: ['True'],
        },
        Tags: [
          { Key: 'StartedBy', Value: 'CloudRescue' },
          { Key: 'TargetInstance', Value: input.instanceId },
        ],
      }),
    );

    return Response.json({
      ok: true,
      executionId: response.AutomationExecutionId,
      region: input.region,
      instanceId: input.instanceId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
