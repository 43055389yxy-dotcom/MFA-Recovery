import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  EC2Client,
  type Instance,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  credentialsSchema,
  errorResponse,
  partitionForRegion,
  toCredentials,
} from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

function nameOf(instance: Instance) {
  return instance.Tags?.find((tag) => tag.Key === 'Name')?.Value || '';
}

async function instancesInRegion(region: string, credentials: ReturnType<typeof toCredentials>) {
  const client = new EC2Client({ region, credentials, maxAttempts: 2 });
  const instances: Instance[] = [];
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new DescribeInstancesCommand({
        Filters: [
          {
            Name: 'instance-state-name',
            Values: ['pending', 'running', 'stopping', 'stopped'],
          },
        ],
        NextToken: nextToken,
        MaxResults: 1000,
      }),
    );
    for (const reservation of response.Reservations || []) {
      instances.push(...(reservation.Instances || []));
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return instances.map((instance) => ({
    id: instance.InstanceId || '',
    region,
    name: nameOf(instance),
    type: instance.InstanceType || '',
    state: instance.State?.Name || '',
    platform: instance.Platform === 'Windows' ? 'Windows' : 'Linux',
    platformDetails: instance.PlatformDetails || '',
    architecture: instance.Architecture || '',
    availabilityZone: instance.Placement?.AvailabilityZone || '',
    publicIp: instance.PublicIpAddress || '',
    privateIp: instance.PrivateIpAddress || '',
    keyName: instance.KeyName || '',
    rootDeviceType: instance.RootDeviceType || '',
    launchTime: instance.LaunchTime?.toISOString() || '',
  }));
}

export async function POST(request: Request) {
  try {
    const input = credentialsSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const sts = new STSClient({ region: 'us-east-1', credentials, maxAttempts: 2 });
    const identity = await sts.send(new GetCallerIdentityCommand({}));

    const homeRegion = 'us-east-1';
    const ec2 = new EC2Client({ region: homeRegion, credentials, maxAttempts: 2 });
    const regionResponse = await ec2.send(new DescribeRegionsCommand({ AllRegions: true }));
    const regions = (regionResponse.Regions || [])
      .filter((region) => region.OptInStatus !== 'not-opted-in' && region.RegionName)
      .map((region) => region.RegionName as string)
      .sort();

    const allInstances: Awaited<ReturnType<typeof instancesInRegion>> = [];
    const warnings: { region: string; message: string }[] = [];
    const concurrency = 6;

    for (let index = 0; index < regions.length; index += concurrency) {
      const batch = regions.slice(index, index + concurrency);
      const results = await Promise.allSettled(
        batch.map((region) => instancesInRegion(region, credentials)),
      );
      results.forEach((result, resultIndex) => {
        if (result.status === 'fulfilled') allInstances.push(...result.value);
        else warnings.push({ region: batch[resultIndex], message: '区域扫描失败或未授权' });
      });
    }

    allInstances.sort((left, right) =>
      `${left.region}:${left.name || left.id}`.localeCompare(`${right.region}:${right.name || right.id}`),
    );

    return Response.json({
      ok: true,
      account: {
        id: identity.Account || '',
        arn: identity.Arn || '',
        partition: partitionForRegion(homeRegion),
      },
      regions,
      instances: allInstances,
      warnings,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
