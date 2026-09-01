import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import {
  EC2InstanceConnectClient,
  SendSSHPublicKeyCommand,
} from '@aws-sdk/client-ec2-instance-connect';
import { z } from 'zod';

import {
  errorResponse,
  recoveryTargetSchema,
  toCredentials,
} from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const eicSchema = recoveryTargetSchema.extend({
  sshPublicKey: recoveryTargetSchema.shape.sshPublicKey.unwrap(),
  osUser: z
    .string()
    .trim()
    .min(1)
    .max(31)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9@._-]{0,30}$/),
});

export async function POST(request: Request) {
  try {
    const input = eicSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const ec2 = new EC2Client({ region: input.region, credentials, maxAttempts: 2 });
    const described = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }),
    );
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error('没有找到该 EC2 实例。');
    if (instance.Platform === 'Windows') {
      return Response.json(
        {
          ok: false,
          error: { code: 'LINUX_ONLY', message: 'EC2 Instance Connect 仅适用于 Linux。' },
        },
        { status: 400 },
      );
    }
    if (instance.State?.Name !== 'running') {
      return Response.json(
        {
          ok: false,
          error: { code: 'INSTANCE_NOT_RUNNING', message: '实例必须处于 Running 状态。' },
        },
        { status: 400 },
      );
    }

    const client = new EC2InstanceConnectClient({
      region: input.region,
      credentials,
      maxAttempts: 2,
    });
    const result = await client.send(
      new SendSSHPublicKeyCommand({
        InstanceId: input.instanceId,
        AvailabilityZone: instance.Placement?.AvailabilityZone,
        InstanceOSUser: input.osUser,
        SSHPublicKey: input.sshPublicKey,
      }),
    );
    if (!result.Success) throw new Error('AWS 未接受这次临时公钥推送。');

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    return Response.json({
      ok: true,
      temporaryAccess: {
        strategy: 'ec2-instance-connect',
        instanceId: input.instanceId,
        osUser: input.osUser,
        publicIp: instance.PublicIpAddress || '',
        privateIp: instance.PrivateIpAddress || '',
        validForSeconds: 60,
        expiresAt,
        permanent: false,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
