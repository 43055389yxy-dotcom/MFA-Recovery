import { GetCommandInvocationCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { credentialsSchema, errorResponse, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const commandStatusSchema = credentialsSchema.extend({
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/),
  commandId: z.uuid(),
});

function cleanOutput(value?: string) {
  return (value || '')
    .replace(/AKIA[A-Z0-9]{12,}/g, '[REDACTED]')
    .replace(/(?:aws_secret_access_key|Secret Access Key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 6_000);
}

export async function POST(request: Request) {
  try {
    const input = commandStatusSchema.parse(await request.json());
    const client = new SSMClient({
      region: input.region,
      credentials: toCredentials(input),
      maxAttempts: 2,
    });
    const result = await client.send(
      new GetCommandInvocationCommand({
        CommandId: input.commandId,
        InstanceId: input.instanceId,
      }),
    );

    return Response.json({
      ok: true,
      command: {
        id: input.commandId,
        status: result.Status || 'Pending',
        statusDetails: result.StatusDetails || '',
        responseCode: result.ResponseCode ?? null,
        startedAt: result.ExecutionStartDateTime || '',
        endedAt: result.ExecutionEndDateTime || '',
        elapsed: result.ExecutionElapsedTime || '',
        stdout: cleanOutput(result.StandardOutputContent),
        stderr: cleanOutput(result.StandardErrorContent),
      },
    });
  } catch (error) {
    const candidate = error as { name?: string };
    if (candidate.name === 'InvocationDoesNotExist') {
      return Response.json({
        ok: true,
        command: {
          status: 'Pending',
          statusDetails: 'AWS 正在分发命令。',
          responseCode: null,
          stdout: '',
          stderr: '',
        },
      });
    }
    return errorResponse(error);
  }
}
