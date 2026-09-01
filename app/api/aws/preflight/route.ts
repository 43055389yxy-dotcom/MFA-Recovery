import { DescribeAutoScalingInstancesCommand, AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';

import { errorResponse, targetSchema, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const input = targetSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const ec2 = new EC2Client({ region: input.region, credentials, maxAttempts: 2 });

    const described = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }),
    );
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (!instance) {
      return Response.json(
        { ok: false, error: { code: 'INSTANCE_NOT_FOUND', message: '没有找到该 EC2 实例。' } },
        { status: 404 },
      );
    }

    const rootMapping = instance.BlockDeviceMappings?.find(
      (mapping) => mapping.DeviceName === instance.RootDeviceName,
    );
    const rootVolumeId = rootMapping?.Ebs?.VolumeId;
    const [volumeResponse, addressResponse, asgResponse] = await Promise.all([
      rootVolumeId
        ? ec2.send(new DescribeVolumesCommand({ VolumeIds: [rootVolumeId] }))
        : Promise.resolve(undefined),
      ec2.send(
        new DescribeAddressesCommand({
          Filters: [{ Name: 'instance-id', Values: [input.instanceId] }],
        }),
      ),
      new AutoScalingClient({ region: input.region, credentials, maxAttempts: 2 }).send(
        new DescribeAutoScalingInstancesCommand({ InstanceIds: [input.instanceId] }),
      ),
    ]);

    const volume = volumeResponse?.Volumes?.[0];
    const autoScalingGroupName = asgResponse.AutoScalingInstances?.[0]?.AutoScalingGroupName || '';
    const isMarketplace = Boolean(instance.ProductCodes?.length);
    const isEbsRoot = instance.RootDeviceType === 'ebs' && Boolean(rootVolumeId);
    const warnings: string[] = [];

    if (!isEbsRoot) warnings.push('根设备不是 EBS，官方离线恢复流程不支持。');
    if (isMarketplace) warnings.push('实例使用 Marketplace 产品代码，EC2Rescue 工作流可能不支持。');
    if (autoScalingGroupName) warnings.push(`实例属于 Auto Scaling 组 ${autoScalingGroupName}，停机可能触发替换。`);
    if (!addressResponse.Addresses?.length && instance.PublicIpAddress) {
      warnings.push('实例没有绑定 Elastic IP，停止并启动后公网 IP 可能变化。');
    }
    if (volume?.Encrypted) warnings.push('根 EBS 已加密，自动化角色需要对应 KMS 权限。');

    return Response.json({
      ok: true,
      preflight: {
        instanceId: input.instanceId,
        region: input.region,
        availabilityZone: instance.Placement?.AvailabilityZone || '',
        platform: instance.Platform === 'Windows' ? 'Windows' : 'Linux',
        rootDeviceType: instance.RootDeviceType || '',
        rootVolumeId: rootVolumeId || '',
        encrypted: Boolean(volume?.Encrypted),
        kmsKeyId: volume?.KmsKeyId || '',
        hasElasticIp: Boolean(addressResponse.Addresses?.length),
        autoScalingGroupName,
        isMarketplace,
        supported: isEbsRoot && !isMarketplace,
        warnings,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
