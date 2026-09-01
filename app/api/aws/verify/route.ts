import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { errorResponse, targetSchema, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const verifySchema = targetSchema.extend({
  originalPublicIp: z.string().max(64).regex(/^[A-Fa-f0-9:.]*$/).optional(),
});

export async function POST(request: Request) {
  try {
    const input = verifySchema.parse(await request.json());
    const credentials = toCredentials(input);
    const ec2 = new EC2Client({ region: input.region, credentials, maxAttempts: 2 });
    const ssm = new SSMClient({ region: input.region, credentials, maxAttempts: 2 });
    const described = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }),
    );
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error('没有找到该 EC2 实例。');
    const securityGroupIds = (instance.SecurityGroups || [])
      .map((group) => group.GroupId)
      .filter((groupId): groupId is string => Boolean(groupId));
    const [statusResult, ssmResult, addressResult, securityGroupResult] =
      await Promise.allSettled([
        ec2.send(
          new DescribeInstanceStatusCommand({
            InstanceIds: [input.instanceId],
            IncludeAllInstances: true,
          }),
        ),
        ssm.send(
          new DescribeInstanceInformationCommand({
            Filters: [{ Key: 'InstanceIds', Values: [input.instanceId] }],
          }),
        ),
        ec2.send(
          new DescribeAddressesCommand({
            Filters: [{ Name: 'instance-id', Values: [input.instanceId] }],
          }),
        ),
        securityGroupIds.length
          ? ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: securityGroupIds }))
          : Promise.resolve(undefined),
      ]);

    const status =
      statusResult.status === 'fulfilled' ? statusResult.value.InstanceStatuses?.[0] : undefined;
    const managed =
      ssmResult.status === 'fulfilled' ? ssmResult.value.InstanceInformationList?.[0] : undefined;
    const addresses =
      addressResult.status === 'fulfilled' ? addressResult.value.Addresses || [] : [];
    const securityGroups =
      securityGroupResult.status === 'fulfilled'
        ? securityGroupResult.value?.SecurityGroups || []
        : [];
    const platform: 'Linux' | 'Windows' =
      instance.Platform === 'Windows' ? 'Windows' : 'Linux';
    const port = platform === 'Windows' ? 3389 : 22;
    const portRulePresent = securityGroups.some((group) =>
      (group.IpPermissions || []).some((permission) => {
        const protocol = permission.IpProtocol === '-1' || permission.IpProtocol === 'tcp';
        const range =
          permission.IpProtocol === '-1' ||
          ((permission.FromPort ?? 65_536) <= port && (permission.ToPort ?? -1) >= port);
        return protocol && range;
      }),
    );
    const publicIp = instance.PublicIpAddress || '';

    return Response.json({
      ok: true,
      verification: {
        instanceId: input.instanceId,
        state: instance.State?.Name || 'unknown',
        platform,
        publicIp,
        publicIpChanged: Boolean(
          input.originalPublicIp && publicIp && input.originalPublicIp !== publicIp,
        ),
        elasticIp: addresses[0]?.PublicIp || '',
        statusChecks: {
          system: status?.SystemStatus?.Status || 'not-applicable',
          instance: status?.InstanceStatus?.Status || 'not-applicable',
          ebs: status?.AttachedEbsStatus?.Status || 'not-applicable',
        },
        ssmPingStatus: managed?.PingStatus || 'NotManaged',
        remotePort: port,
        remotePortSecurityGroupRule: portRulePresent,
        note:
          '端口结果仅表示安全组存在对应入站规则；托管网页无法通过 AWS API 直接验证操作系统端口监听状态。',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
