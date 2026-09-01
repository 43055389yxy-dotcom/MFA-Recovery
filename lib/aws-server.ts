import type { AwsCredentialIdentity } from '@smithy/types';
import { z } from 'zod';

export const credentialsSchema = z.object({
  accessKeyId: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Z0-9]+$/),
  secretAccessKey: z.string().trim().min(32).max(256),
});

export const targetSchema = credentialsSchema.extend({
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/),
});

export function toCredentials(input: z.infer<typeof credentialsSchema>): AwsCredentialIdentity {
  return {
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  };
}

export function partitionForRegion(region: string) {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  return 'aws';
}

export function publicError(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'INVALID_INPUT', message: '输入格式不正确，请检查后重试。' };
  }

  const candidate = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = candidate.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || candidate.name === 'UnrecognizedClientException') {
    return { status: 401, code: 'INVALID_CREDENTIALS', message: 'AK/SK 无效或权限不足。' };
  }

  if (candidate.name === 'AccessDeniedException' || candidate.name === 'UnauthorizedOperation') {
    return { status: 403, code: 'ACCESS_DENIED', message: '当前专用凭证缺少所需权限。' };
  }

  return {
    status: 500,
    code: candidate.name || 'AWS_REQUEST_FAILED',
    message: candidate.message?.slice(0, 280) || 'AWS 请求失败，请稍后重试。',
  };
}

export function errorResponse(error: unknown) {
  const normalized = publicError(error);
  return Response.json(
    { ok: false, error: { code: normalized.code, message: normalized.message } },
    { status: normalized.status },
  );
}
