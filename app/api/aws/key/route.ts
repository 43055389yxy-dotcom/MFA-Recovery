import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { credentialsSchema, errorResponse, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const keySchema = credentialsSchema.extend({
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  parameterName: z.string().regex(/^\/ec2rl\/openssh\/[A-Za-z0-9_./-]+$/),
});

export async function POST(request: Request) {
  try {
    const input = keySchema.parse(await request.json());
    const client = new SSMClient({
      region: input.region,
      credentials: toCredentials(input),
      maxAttempts: 2,
    });
    const response = await client.send(
      new GetParameterCommand({ Name: input.parameterName, WithDecryption: true }),
    );
    return Response.json({ ok: true, privateKey: response.Parameter?.Value || '' });
  } catch (error) {
    return errorResponse(error);
  }
}
