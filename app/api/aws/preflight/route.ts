import { AutoScalingClient, DescribeAutoScalingInstancesCommand } from '@aws-sdk/client-auto-scaling';
import {
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeInstanceConnectEndpointsCommand,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeInstanceTypesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVolumesCommand,
  EC2Client,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, SSMClient } from '@aws-sdk/client-ssm';

import { errorResponse, targetSchema, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

function permissionAllowsPort(permission: IpPermission, port: number) {
  const protocolMatches = permission.IpProtocol === '-1' || permission.IpProtocol === 'tcp';
  const portMatches =
    permission.IpProtocol === '-1' ||
    ((permission.FromPort ?? Number.POSITIVE_INFINITY) <= port &&
      (permission.ToPort ?? Number.NEGATIVE_INFINITY) >= port);
  const hasSource = Boolean(
    permission.IpRanges?.length ||
      permission.Ipv6Ranges?.length ||
      permission.UserIdGroupPairs?.length ||
      permission.PrefixListIds?.length,
  );
  return protocolMatches && portMatches && hasSource;
}

export async function POST(request: Request) {
  try {
    const input = targetSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const ec2 = new EC2Client({ region: input.region, credentials, maxAttempts: 2 });
    const ssm = new SSMClient({ region: input.region, credentials, maxAttempts: 2 });

    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }));
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
    const rootVolumeId = rootMapping?.Ebs?.VolumeId || '';
    const securityGroupIds = (instance.SecurityGroups || [])
      .map((group) => group.GroupId)
      .filter((groupId): groupId is string => Boolean(groupId));

    const [
      volumeResult,
      addressesResult,
      asgResult,
      statusResult,
      ssmResult,
      securityGroupsResult,
      imageResult,
      endpointResult,
      instanceTypeResult,
    ] = await Promise.allSettled([
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
      securityGroupIds.length
        ? ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: securityGroupIds }))
        : Promise.resolve(undefined),
      instance.ImageId
        ? ec2.send(new DescribeImagesCommand({ ImageIds: [instance.ImageId] }))
        : Promise.resolve(undefined),
      instance.VpcId
        ? ec2.send(
            new DescribeInstanceConnectEndpointsCommand({
              Filters: [{ Name: 'vpc-id', Values: [instance.VpcId] }],
            }),
          )
        : Promise.resolve(undefined),
      instance.InstanceType
        ? ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [instance.InstanceType] }))
        : Promise.resolve(undefined),
    ]);

    const volume =
      volumeResult.status === 'fulfilled' ? volumeResult.value?.Volumes?.[0] : undefined;
    const addresses =
      addressesResult.status === 'fulfilled' ? addressesResult.value.Addresses || [] : [];
    const asg =
      asgResult.status === 'fulfilled' ? asgResult.value.AutoScalingInstances?.[0] : undefined;
    const instanceStatus =
      statusResult.status === 'fulfilled' ? statusResult.value.InstanceStatuses?.[0] : undefined;
    const managed =
      ssmResult.status === 'fulfilled' ? ssmResult.value.InstanceInformationList?.[0] : undefined;
    const securityGroups =
      securityGroupsResult.status === 'fulfilled'
        ? securityGroupsResult.value?.SecurityGroups || []
        : [];
    const image = imageResult.status === 'fulfilled' ? imageResult.value?.Images?.[0] : undefined;
    const connectEndpoints =
      endpointResult.status === 'fulfilled'
        ? (endpointResult.value?.InstanceConnectEndpoints || []).filter(
            (endpoint) => endpoint.State === 'create-complete',
          )
        : [];
    const instanceTypeInfo =
      instanceTypeResult.status === 'fulfilled'
        ? instanceTypeResult.value?.InstanceTypes?.[0]
        : undefined;

    const platform: 'Linux' | 'Windows' =
      instance.Platform === 'Windows' ? 'Windows' : 'Linux';
    const port = platform === 'Windows' ? 3389 : 22;
    const portRulePresent = securityGroups.some((group) =>
      (group.IpPermissions || []).some((permission) => permissionAllowsPort(permission, port)),
    );
    const imageText = `${image?.Name || ''} ${image?.Description || ''} ${instance.PlatformDetails || ''}`;
    const eicOsHint = /amazon linux|al2023|ubuntu|centos stream|red hat|rhel|rocky|alma/i.test(
      imageText,
    );
    const eicNetworkPath = Boolean(instance.PublicIpAddress || connectEndpoints.length);
    const ssmOnline = managed?.PingStatus === 'Online';
    const isMarketplace = Boolean(instance.ProductCodes?.length);
    const isEbsRoot = instance.RootDeviceType === 'ebs' && Boolean(rootVolumeId);
    const hasInstanceStore =
      instance.RootDeviceType === 'instance-store' ||
      Boolean(
        instanceTypeInfo?.InstanceStorageSupported &&
          instanceTypeInfo.InstanceStorageInfo?.Disks?.length,
      );
    const autoScalingGroupName = asg?.AutoScalingGroupName || '';
    const warnings: string[] = [];

    if (!isEbsRoot) warnings.push('根设备不是 EBS，AWSSupport-ResetAccess 不支持。');
    if (isMarketplace)
      warnings.push('实例带有 Marketplace 产品代码，官方 EC2Rescue 流程可能不支持。');
    if (autoScalingGroupName)
      warnings.push(`实例属于 Auto Scaling 组 ${autoScalingGroupName}，停机可能触发替换。`);
    if (!addresses.length && instance.PublicIpAddress)
      warnings.push('未绑定 Elastic IP，停止再启动后公网 IP 可能变化。');
    if (volume?.Encrypted)
      warnings.push('根 EBS 已加密，自动化角色必须拥有对应 KMS Key 权限。');
    if (hasInstanceStore)
      warnings.push('实例规格包含或支持 Instance Store；如已映射，停机会丢失其中的数据。');
    if (!portRulePresent)
      warnings.push(`安全组未发现 ${port}/TCP 入站规则，远程登录可能仍不可达。`);

    return Response.json({
      ok: true,
      assessment: {
        instance: {
          id: input.instanceId,
          name: instance.Tags?.find((tag) => tag.Key === 'Name')?.Value || '',
          region: input.region,
          state: instance.State?.Name || 'unknown',
          platform,
          platformDetails: instance.PlatformDetails || '',
          architecture: instance.Architecture || '',
          imageId: instance.ImageId || '',
          imageName: image?.Name || '',
          instanceType: instance.InstanceType || '',
          availabilityZone: instance.Placement?.AvailabilityZone || '',
          vpcId: instance.VpcId || '',
          subnetId: instance.SubnetId || '',
          securityGroups: (instance.SecurityGroups || []).map((group) => ({
            id: group.GroupId || '',
            name: group.GroupName || '',
          })),
          publicIp: instance.PublicIpAddress || '',
          privateIp: instance.PrivateIpAddress || '',
          elasticIp: addresses[0]?.PublicIp || '',
          iamInstanceProfile: instance.IamInstanceProfile?.Arn || '',
          keyName: instance.KeyName || '',
          rootDeviceType: instance.RootDeviceType || '',
          rootVolumeId,
          rootVolumeEncrypted: Boolean(volume?.Encrypted),
          kmsKeyId: volume?.KmsKeyId || '',
          autoScalingGroupName,
          hasInstanceStore,
          isMarketplace,
        },
        ssm: {
          managed: Boolean(managed),
          pingStatus: managed?.PingStatus || 'NotManaged',
          platformName: managed?.PlatformName || '',
          platformVersion: managed?.PlatformVersion || '',
          agentVersion: managed?.AgentVersion || '',
          lastPingAt: managed?.LastPingDateTime?.toISOString() || '',
          online: ssmOnline,
        },
        statusChecks: {
          system: instanceStatus?.SystemStatus?.Status || 'not-applicable',
          instance: instanceStatus?.InstanceStatus?.Status || 'not-applicable',
          ebs: instanceStatus?.AttachedEbsStatus?.Status || 'not-applicable',
        },
        network: {
          port,
          portRulePresent,
          instanceConnectEndpointId:
            connectEndpoints[0]?.InstanceConnectEndpointId || '',
          instanceConnectEndpointState: connectEndpoints[0]?.State || '',
        },
        strategies: {
          ssm: {
            available: ssmOnline && instance.State?.Name === 'running',
            reason: ssmOnline
              ? 'SSM Agent 在线，可在不停机状态下执行修复。'
              : `SSM 当前状态：${managed?.PingStatus || '未托管'}。`,
          },
          instanceConnect: {
            applicable: platform === 'Linux',
            available:
              platform === 'Linux' &&
              instance.State?.Name === 'running' &&
              eicNetworkPath &&
              portRulePresent,
            confidence: eicOsHint ? 'likely' : 'unknown',
            osHintSupported: eicOsHint,
            networkPath: eicNetworkPath,
            reason:
              platform !== 'Linux'
                ? '仅适用于 Linux。'
                : !eicNetworkPath
                  ? '没有公网 IP，也未发现可用的 Instance Connect Endpoint。'
                  : !portRulePresent
                    ? '安全组未发现 22/TCP 入站路径。'
                    : eicOsHint
                      ? '网络与镜像特征符合条件，可发送 60 秒临时公钥。'
                      : '网络条件符合，但无法仅通过 AWS API 确认实例内已安装 EC2 Instance Connect。',
          },
          troubleshoot: {
            available: ssmOnline && instance.State?.Name === 'running',
            document:
              platform === 'Windows'
                ? 'AWSSupport-TroubleshootRDP'
                : 'AWSSupport-TroubleshootSSH',
            reason: ssmOnline
              ? '可运行 AWS 官方在线排障，明确禁止离线操作。'
              : '官方在线排障同样依赖 SSM 在线。',
          },
          offline: {
            available: isEbsRoot && !isMarketplace,
            requiresStop: true,
            warnings,
          },
        },
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
