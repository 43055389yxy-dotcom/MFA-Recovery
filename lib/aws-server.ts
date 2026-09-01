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

export const sshPublicKeySchema = z
  .string()
  .trim()
  .min(32)
  .max(16_384)
  .regex(
    /^(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+[^\r\n]{1,512})?$/,
  );

export const recoveryTargetSchema = targetSchema.extend({
  sshPublicKey: sshPublicKeySchema.optional(),
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
  if (candidate.name === 'AccessDeniedException' || candidate.name === 'UnauthorizedOperation') {
    return { status: 403, code: 'ACCESS_DENIED', message: '当前专用凭证缺少所需权限。' };
  }

  if (status === 401 || candidate.name === 'UnrecognizedClientException') {
    return { status: 401, code: 'INVALID_CREDENTIALS', message: 'AK/SK 无效。' };
  }

  if (status === 403) {
    return { status: 403, code: 'ACCESS_DENIED', message: '当前专用凭证缺少所需权限。' };
  }

  if (candidate.name === 'InvalidInstanceId') {
    return {
      status: 400,
      code: 'INSTANCE_NOT_MANAGED',
      message: '该实例当前无法通过 Systems Manager 接收命令。',
    };
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
