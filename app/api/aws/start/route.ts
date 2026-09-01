import {
  DescribeDocumentCommand,
  StartAutomationExecutionCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
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
  subnetId: z
    .string()
    .regex(/^(?:CreateNewVPC|SelectedInstanceSubnet|subnet-[a-f0-9]{8,17})$/)
    .default('CreateNewVPC'),
  helperInstanceProfileName: z.string().regex(/^[A-Za-z0-9+=,.@_-]{1,128}$/).optional(),
  helperInstanceSecurityGroupId: z.string().regex(/^sg-[a-f0-9]{8,17}$/).optional(),
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
    const document = await client.send(
      new DescribeDocumentCommand({ Name: 'AWSSupport-ResetAccess', DocumentVersion: '$DEFAULT' }),
    );
    const supportedParameters = new Set(
      (document.Document?.Parameters || []).map((parameter) => parameter.Name),
    );
    const requestedParameters: Record<string, string[]> = {
      InstanceId: [input.instanceId],
      AutomationAssumeRole: [automationRole],
      EC2RescueInstanceType: ['t2.small'],
      SubnetId: [input.subnetId],
      AllowEncryptedVolume: [input.encrypted ? 'True' : 'False'],
      AssociatePublicIpAddress: ['True'],
    };
    if (input.helperInstanceProfileName) {
      requestedParameters.HelperInstanceProfileName = [input.helperInstanceProfileName];
    }
    if (input.helperInstanceSecurityGroupId) {
      requestedParameters.HelperInstanceSecurityGroupId = [input.helperInstanceSecurityGroupId];
    }
    const parameters = Object.fromEntries(
      Object.entries(requestedParameters).filter(([name]) => supportedParameters.has(name)),
    );
    const response = await client.send(
      new StartAutomationExecutionCommand({
        DocumentName: 'AWSSupport-ResetAccess',
        DocumentVersion: '$DEFAULT',
        ClientToken: crypto.randomUUID(),
        Parameters: parameters,
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
      parameterNames: Object.keys(parameters),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
