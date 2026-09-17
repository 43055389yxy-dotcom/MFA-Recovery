import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

import { MFA_TARGET_ROLE_NAME, targetRoleArn } from '../lib/mfa-role-config.js';

const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.MFA_API_PORT || '3198', 10);
const host = process.env.MFA_API_HOST || '127.0.0.1';
const awsCliPath = process.env.AWS_CLI_PATH || '/usr/local/bin/aws';
const storageService = 'mfa-recovery-storage';
let cachedStorageConfig;

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请求内容不正确。');
  if (!/^\d{12}$/.test(String(input.accountId || ''))) {
    throw new Error('目标账号 ID 必须是 12 位数字。');
  }
}

function validatePayerAccountInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请求内容不正确。');
  if (!/^\d{12}$/.test(String(input.payerAccountId || ''))) {
    throw new Error('代付管理账号 ID 必须是 12 位数字。');
  }
}

function awsEnvironment(input) {
  const environment = {
    ...process.env,
    AWS_PAGER: '',
    AWS_DEFAULT_REGION: input.region || 'us-east-1',
  };
  if (input.accessKeyId && input.secretAccessKey) {
    environment.AWS_ACCESS_KEY_ID = input.accessKeyId;
    environment.AWS_SECRET_ACCESS_KEY = input.secretAccessKey;
    if (input.sessionToken) environment.AWS_SESSION_TOKEN = input.sessionToken;
  }
  return environment;
}

function temporaryInput(source, credentials) {
  return {
    ...source,
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}

async function aws(input, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(
      awsCliPath,
      [...args, '--no-cli-pager', '--output', 'json'],
      {
        env: awsEnvironment(input),
        timeout: options.timeout || 45_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const lines = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const awsError = lines.find((line) =>
      /(?:aws:\s*\[ERROR\]:\s*)?An error occurred/i.test(line),
    );
    const usefulLine = lines.find(
      (line) =>
        !/^Additional error details:?$/i.test(line) &&
        !/^(?:RequestId|Request ID|request ID):/i.test(line),
    );
    throw new Error(
      (awsError || usefulLine || error?.message || 'AWS CLI 请求失败。')
        .replace(/^aws:\s*\[ERROR\]:\s*/i, '')
        .trim(),
    );
  }
}

async function keychainSecret(service, account) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Keychain is unavailable.');
  }
  const result = await execFileAsync('/usr/bin/security', [
    'find-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
  ]);
  return result.stdout.trim();
}

async function storageConfig() {
  if (cachedStorageConfig) return cachedStorageConfig;
  const environmentConfig = {
    accessKeyId: process.env.MFA_STORAGE_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.MFA_STORAGE_SECRET_ACCESS_KEY || '',
    region: process.env.MFA_STORAGE_REGION || '',
    tableName: process.env.MFA_STORAGE_TABLE_NAME || '',
    kmsKeyId: process.env.MFA_STORAGE_KMS_KEY_ID || '',
    partitionKey: process.env.MFA_STORAGE_PARTITION_KEY || '',
  };
  const storageLocationConfigured = [
    environmentConfig.region,
    environmentConfig.tableName,
    environmentConfig.partitionKey,
  ].every(Boolean);
  const staticCredentialsConfigured = Boolean(
    environmentConfig.accessKeyId && environmentConfig.secretAccessKey,
  );
  const partialStaticCredentials = Boolean(
    environmentConfig.accessKeyId || environmentConfig.secretAccessKey,
  );
  if (partialStaticCredentials && !staticCredentialsConfigured) {
    throw new Error('服务端存储凭证不完整。');
  }
  if (
    storageLocationConfigured &&
    (staticCredentialsConfigured || process.platform !== 'darwin')
  ) {
    cachedStorageConfig = environmentConfig;
    return cachedStorageConfig;
  }
  if (process.platform !== 'darwin') {
    throw new Error('服务端存储配置不完整。');
  }
  const [
    accessKeyId,
    secretAccessKey,
    region,
    tableName,
    kmsKeyId,
    partitionKey,
  ] = await Promise.all([
    keychainSecret(storageService, 'access-key-id'),
    keychainSecret(storageService, 'secret-access-key'),
    keychainSecret(storageService, 'region'),
    keychainSecret(storageService, 'table-name'),
    keychainSecret(storageService, 'kms-key-id'),
    keychainSecret(storageService, 'partition-key'),
  ]);
  cachedStorageConfig = {
    accessKeyId,
    secretAccessKey,
    region,
    tableName,
    kmsKeyId,
    partitionKey,
  };
  return cachedStorageConfig;
}

async function storageAws(args) {
  return aws(await storageConfig(), args);
}

function dynamoString(item, key) {
  return item?.[key]?.S || '';
}

async function readDynamoProfiles() {
  const config = await storageConfig();
  const result = await storageAws([
    'dynamodb',
    'scan',
    '--table-name',
    config.tableName,
    '--consistent-read',
  ]);
  const profiles = (result.Items || []).map((item) => {
    const id = dynamoString(item, config.partitionKey);
    return {
      id,
      accountId: dynamoString(item, 'accountId'),
      callerArn: dynamoString(item, 'callerArn'),
      roleArn: dynamoString(item, 'roleArn'),
      label: dynamoString(item, 'label'),
      lastTargetAccountId: '',
      source: 'saved',
      addedAt: dynamoString(item, 'addedAt'),
      updatedAt: dynamoString(item, 'updatedAt'),
    };
  });
  return profiles
    .filter((profile) => profile.roleArn)
    .sort((left, right) =>
      String(right.updatedAt).localeCompare(String(left.updatedAt)),
    );
}

async function putDynamoProfile(profile) {
  const config = await storageConfig();
  const roleReady = Boolean(profile.roleArn);
  const item = {
    [config.partitionKey]: { S: profile.id },
    accountId: { S: profile.accountId },
    callerArn: { S: profile.callerArn || '' },
    label: { S: profile.label || `代付账号 ${profile.accountId}` },
    credentialStatus: { S: roleReady ? 'ready' : 'missing' },
    lastTargetAccountId: { S: '' },
    source: { S: 'saved' },
    addedAt: { S: profile.addedAt || new Date().toISOString() },
    updatedAt: { S: profile.updatedAt || new Date().toISOString() },
  };
  if (roleReady) item.roleArn = { S: profile.roleArn };
  await storageAws([
    'dynamodb',
    'put-item',
    '--table-name',
    config.tableName,
    '--item',
    JSON.stringify(item),
  ]);
}

async function deleteDynamoProfile(profileId) {
  const config = await storageConfig();
  await storageAws([
    'dynamodb',
    'delete-item',
    '--table-name',
    config.tableName,
    '--key',
    JSON.stringify({ [config.partitionKey]: { S: profileId } }),
  ]);
}

async function readPayerProfiles() {
  return readDynamoProfiles();
}

async function writePayerProfiles(profiles) {
  const existing = await readPayerProfiles();
  await Promise.all(profiles.map((profile) => putDynamoProfile(profile)));
  await Promise.all(
    existing
      .filter(
        (profile) => !profiles.some((candidate) => candidate.id === profile.id),
      )
      .map((profile) => deleteDynamoProfile(profile.id)),
  );
}

function publicPayerProfile(profile) {
  const roleReady = Boolean(profile.roleArn);
  return {
    id: profile.id,
    accountId: profile.accountId,
    label: profile.label || `代付账号 ${profile.accountId}`,
    roleArn: profile.roleArn || '',
    connectionLabel: roleReady
      ? `受信任 Role · ${MFA_TARGET_ROLE_NAME}`
      : '待重新授权',
    credentialStatus: roleReady ? 'ready' : 'missing',
    lastTargetAccountId: '',
    source: 'saved',
  };
}

async function listPayerProfiles() {
  return { profiles: (await readPayerProfiles()).map(publicPayerProfile) };
}

async function savePayerProfile(input, caller) {
  const profiles = await readPayerProfiles();
  const now = new Date().toISOString();
  const existing = profiles.find(
    (candidate) => candidate.accountId === caller.Account,
  );
  const requestedLabel = String(input.label || '')
    .trim()
    .slice(0, 40);
  const profile = {
    id: `payer:${caller.Account}`,
    accountId: caller.Account,
    callerArn: caller.Arn || '',
    roleArn: targetRoleArn(caller.Account),
    label: requestedLabel || existing?.label || `代付账号 ${caller.Account}`,
    lastTargetAccountId: '',
    source: 'saved',
    addedAt: existing?.addedAt || now,
    updatedAt: now,
  };
  const next = [
    profile,
    ...profiles.filter((candidate) => candidate.accountId !== caller.Account),
  ];
  await writePayerProfiles(next);
  return publicPayerProfile(profile);
}

async function updatePayerLabel(input) {
  const label = String(input.label || '')
    .trim()
    .slice(0, 40);
  if (!label) throw new Error('请输入账号备注。');

  const profiles = await readPayerProfiles();
  const index = profiles.findIndex(
    (profile) => profile.id === String(input.profileId || ''),
  );
  if (index < 0) throw new Error('没有找到需要修改的代付账号。');
  const next = profiles.map((profile, profileIndex) =>
    profileIndex === index
      ? { ...profile, label, updatedAt: new Date().toISOString() }
      : profile,
  );
  await writePayerProfiles(next);
  return { profile: publicPayerProfile(next[index]) };
}

async function deletePayerProfile(input) {
  const profileId = String(input.profileId || '');
  if (!profileId) throw new Error('没有找到需要删除的代付账号。');

  const profiles = await readPayerProfiles();
  if (!profiles.some((profile) => profile.id === profileId)) {
    throw new Error('没有找到需要删除的代付账号。');
  }
  await writePayerProfiles(
    profiles.filter((profile) => profile.id !== profileId),
  );

  return {
    deletedProfileId: profileId,
    ...(await listPayerProfiles()),
  };
}

async function assumePayerRole(accountId, roleArn = targetRoleArn(accountId)) {
  if (!/^\d{12}$/.test(String(accountId || ''))) {
    throw new Error('代付管理账号 ID 必须是 12 位数字。');
  }

  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await aws({}, [
        'sts',
        'assume-role',
        '--role-arn',
        roleArn,
        '--role-session-name',
        'MfaRecoveryWeb',
        '--duration-seconds',
        '3600',
      ]);
      if (!result.Credentials?.AccessKeyId) {
        throw new Error('无法取得代付账号 Role 的临时凭证。');
      }
      return temporaryInput(
        { payerAccountId: accountId, roleArn },
        result.Credentials,
      );
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  throw new Error(
    `无法进入 ${MFA_TARGET_ROLE_NAME}，请先在代付管理账号执行 CloudShell 授权命令。${lastError?.message ? ` ${lastError.message}` : ''}`,
  );
}

async function resolveInput(input) {
  if (!input?.profileId) return input;

  const profiles = await readPayerProfiles();
  const profile = profiles.find(
    (candidate) => candidate.id === input.profileId,
  );
  if (!profile) throw new Error('没有找到已保存的代付账号。');
  if (!profile.roleArn) {
    throw new Error(
      '该账号仍是旧 AK/SK 接入方式，请重新执行 CloudShell 命令授权 Role。',
    );
  }
  const assumed = await assumePayerRole(profile.accountId, profile.roleArn);
  return {
    ...input,
    ...assumed,
    accountId: input.accountId || profile.lastTargetAccountId,
  };
}

async function preflight(input) {
  validateInput(input);
  const [caller, organizationResult, targetResult, serviceAccess] =
    await Promise.all([
      aws(input, ['sts', 'get-caller-identity']),
      aws(input, ['organizations', 'describe-organization']),
      aws(input, [
        'organizations',
        'describe-account',
        '--account-id',
        input.accountId,
      ]),
      aws(input, ['organizations', 'list-aws-service-access-for-organization']),
    ]);

  const organization = organizationResult.Organization || {};
  const managementAccountId =
    organization.ManagementAccountId || organization.MasterAccountId || '';
  const target = targetResult.Account || {};
  const trustedAccessEnabled = Boolean(
    serviceAccess.EnabledServicePrincipals?.some(
      (service) => service.ServicePrincipal === 'iam.amazonaws.com',
    ),
  );
  let features = { EnabledFeatures: [] };
  let delegates = { DelegatedAdministrators: [] };
  if (trustedAccessEnabled) {
    try {
      [features, delegates] = await Promise.all([
        aws(input, ['iam', 'list-organizations-features']),
        aws(input, [
          'organizations',
          'list-delegated-administrators',
          '--service-principal',
          'iam.amazonaws.com',
        ]),
      ]);
    } catch (error) {
      if (
        !/ServiceAccessNotEnabledException|Trusted Access for IAM not enabled/i.test(
          error.message,
        )
      ) {
        throw error;
      }
    }
  }
  const enabledFeatures = new Set(features.EnabledFeatures || []);
  const delegate = delegates.DelegatedAdministrators?.[0] || {};

  if (caller.Account !== managementAccountId) {
    throw new Error('当前凭证不属于 AWS Organizations 管理账号。');
  }
  if ((target.State || target.Status) !== 'ACTIVE') {
    throw new Error('目标成员账号当前不是 ACTIVE 状态。');
  }

  return {
    caller: { accountId: caller.Account || '', arn: caller.Arn || '' },
    organization: {
      id: organization.Id || '',
      managementAccountId,
      callerIsManagementAccount: caller.Account === managementAccountId,
    },
    target: {
      accountId: target.Id || input.accountId,
      name: target.Name || '',
      state: target.State || target.Status || '',
    },
    rootAccess: {
      trustedAccessEnabled,
      rootSessionsEnabled: enabledFeatures.has('RootSessions'),
      rootCredentialsManagementEnabled: enabledFeatures.has(
        'RootCredentialsManagement',
      ),
    },
    delegatedAdmin: {
      configured: Boolean(delegate.Id),
      matchesTarget: delegate.Id === input.accountId,
      accountId: delegate.Id || '',
      name: delegate.Name || '',
    },
  };
}

async function enableCentralizedRootAccess(input) {
  const current = await preflight(input);
  const changes = [];

  if (!current.rootAccess.trustedAccessEnabled) {
    await aws(input, [
      'organizations',
      'enable-aws-service-access',
      '--service-principal',
      'iam.amazonaws.com',
    ]);
    changes.push('已启用 IAM Organizations 可信访问');
  }

  if (!current.rootAccess.rootCredentialsManagementEnabled) {
    await aws(input, [
      'iam',
      'enable-organizations-root-credentials-management',
    ]);
    changes.push('已启用根凭证管理');
  }

  if (!current.rootAccess.rootSessionsEnabled) {
    await aws(input, ['iam', 'enable-organizations-root-sessions']);
    changes.push('已启用成员账号特权根操作');
  }

  return {
    changes,
    preflight: await preflight(input),
  };
}

async function registerPayerAccount(input) {
  validatePayerAccountInput(input);
  const assumed = await assumePayerRole(input.payerAccountId);
  const [caller, organizationResult] = await Promise.all([
    aws(assumed, ['sts', 'get-caller-identity']),
    aws(assumed, ['organizations', 'describe-organization']),
  ]);
  if (!caller.Account || !caller.Arn) throw new Error('无法识别执行账号。');
  const organization = organizationResult.Organization || {};
  const managementAccountId =
    organization.ManagementAccountId || organization.MasterAccountId || '';
  if (
    caller.Account !== input.payerAccountId ||
    caller.Account !== managementAccountId
  ) {
    throw new Error('请在 AWS Organizations 管理账号中创建受信任 Role。');
  }

  return {
    ready: true,
    caller: { accountId: caller.Account, arn: caller.Arn },
    profile: await savePayerProfile(input, caller),
  };
}

async function checkPayerAccount(input) {
  validateInput(input);
  const caller = await aws(input, ['sts', 'get-caller-identity']);
  if (!caller.Account || !caller.Arn) throw new Error('无法识别代付账号。');
  const status = await preflight(input);
  const stored = input.profileId?.startsWith('payer:')
    ? (await readPayerProfiles()).find(
        (candidate) => candidate.id === input.profileId,
      )
    : null;
  if (!stored) throw new Error('没有找到已保存的代付账号。');
  return {
    ready: true,
    profile: publicPayerProfile(stored),
    preflight: status,
  };
}

async function assumeRoot(input, taskPolicyName) {
  validateInput(input);
  const result = await aws(input, [
    'sts',
    'assume-root',
    '--region',
    'us-east-1',
    '--target-principal',
    input.accountId,
    '--task-policy-arn',
    `arn=arn:aws:iam::aws:policy/root-task/${taskPolicyName}`,
    '--duration-seconds',
    '900',
  ]);
  if (!result.Credentials?.AccessKeyId) {
    throw new Error('无法取得目标账号的短期根会话。');
  }
  return temporaryInput(input, result.Credentials);
}

async function optionalAws(input, args) {
  try {
    return await aws(input, args);
  } catch (error) {
    if (/NoSuchEntity|not found/i.test(error.message)) return null;
    throw error;
  }
}

async function readRootStatus(rootInput) {
  const [profile, accessKeys, certificates, mfaDevices] = await Promise.all([
    optionalAws(rootInput, ['iam', 'get-login-profile']),
    aws(rootInput, ['iam', 'list-access-keys']),
    aws(rootInput, ['iam', 'list-signing-certificates']),
    aws(rootInput, ['iam', 'list-mfa-devices']),
  ]);
  return {
    passwordPresent: Boolean(profile?.LoginProfile),
    accessKeys: accessKeys?.AccessKeyMetadata || [],
    signingCertificates: certificates?.Certificates || [],
    mfaDevices: mfaDevices?.MFADevices || [],
  };
}

async function auditRootCredentials(input) {
  const rootInput = await assumeRoot(input, 'IAMAuditRootUserCredentials');
  return readRootStatus(rootInput);
}

async function deleteRootCredentials(input) {
  validateInput(input);
  if (String(input.confirmationAccountId || '') !== input.accountId) {
    throw new Error('目标账号 ID 二次确认不匹配，已取消清除。');
  }

  const rootInput = await assumeRoot(input, 'IAMDeleteRootUserCredentials');
  const status = await readRootStatus(rootInput);
  const changes = [];

  if (status.passwordPresent) {
    await aws(rootInput, ['iam', 'delete-login-profile']);
    changes.push('已删除根用户密码');
  }
  for (const key of status.accessKeys) {
    if (!key.AccessKeyId) continue;
    await aws(rootInput, [
      'iam',
      'delete-access-key',
      '--access-key-id',
      key.AccessKeyId,
    ]);
    changes.push(`已删除根访问密钥 ${key.AccessKeyId.slice(-4)}`);
  }
  for (const certificate of status.signingCertificates) {
    if (!certificate.CertificateId) continue;
    await aws(rootInput, [
      'iam',
      'delete-signing-certificate',
      '--certificate-id',
      certificate.CertificateId,
    ]);
    changes.push('已删除根签名证书');
  }
  for (const device of status.mfaDevices) {
    if (!device.SerialNumber) continue;
    await aws(rootInput, [
      'iam',
      'deactivate-mfa-device',
      '--serial-number',
      device.SerialNumber,
    ]);
    changes.push('已停用根用户 MFA');
  }

  const verified = await auditRootCredentials(input);
  if (
    verified.passwordPresent ||
    verified.accessKeys.length ||
    verified.signingCertificates.length ||
    verified.mfaDevices.length
  ) {
    throw new Error('根凭证仍有残留，请重新扫描后再处理。');
  }
  if (!changes.length) changes.push('目标账号已无根凭证，无需重复清除');
  return { changes, status: verified };
}

async function allowPasswordRecovery(input) {
  validateInput(input);
  const rootInput = await assumeRoot(input, 'IAMCreateRootUserPassword');
  try {
    await aws(rootInput, ['iam', 'create-login-profile']);
  } catch (error) {
    if (!/EntityAlreadyExists|already exists/i.test(error.message)) throw error;
  }
  const profile = await optionalAws(rootInput, ['iam', 'get-login-profile']);
  if (!profile?.LoginProfile) {
    throw new Error('AWS 尚未开放密码恢复，请稍后重试。');
  }
  return { changes: ['已允许目标账号通过根用户邮箱重置密码'] };
}

async function cleanupDelegation(input) {
  validateInput(input);
  const current = await preflight(input);
  const changes = [];
  if (current.delegatedAdmin.matchesTarget) {
    await aws(input, [
      'organizations',
      'deregister-delegated-administrator',
      '--account-id',
      input.accountId,
      '--service-principal',
      'iam.amazonaws.com',
    ]);
    changes.push(`已移除 ${input.accountId} 的 IAM 委派管理员权限`);
  }
  return { changes, preflight: await preflight(input) };
}

function corsHeaders() {
  return {
    'access-control-allow-origin': 'http://localhost:3000',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
}

function respond(response, status, payload) {
  response.writeHead(status, corsHeaders());
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    respond(response, 200, { ok: true });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    respond(response, 405, {
      ok: false,
      error: { message: '只支持 POST 请求。' },
    });
    return;
  }

  try {
    const requestInput = await readJson(request);
    const input = [
      '/api/aws/mfa/profiles/list',
      '/api/aws/mfa/profiles/register',
      '/api/aws/mfa/profiles/label',
      '/api/aws/mfa/profiles/delete',
    ].includes(request.url)
      ? requestInput
      : await resolveInput(requestInput);
    let result;
    switch (request.url) {
      case '/api/aws/mfa/profiles/list':
        result = await listPayerProfiles();
        break;
      case '/api/aws/mfa/profiles/register':
        result = await registerPayerAccount(input);
        break;
      case '/api/aws/mfa/profiles/connect':
        result = await checkPayerAccount(input);
        break;
      case '/api/aws/mfa/profiles/label':
        result = await updatePayerLabel(input);
        break;
      case '/api/aws/mfa/profiles/delete':
        result = await deletePayerProfile(input);
        break;
      case '/api/aws/mfa/preflight':
        result = { preflight: await preflight(input) };
        break;
      case '/api/aws/mfa/root/enable':
        result = await enableCentralizedRootAccess(input);
        break;
      case '/api/aws/mfa/root/status':
        result = await auditRootCredentials(input);
        break;
      case '/api/aws/mfa/root/delete':
        result = await deleteRootCredentials(input);
        break;
      case '/api/aws/mfa/root/recover':
        result = await allowPasswordRecovery(input);
        break;
      case '/api/aws/mfa/cleanup':
        result = await cleanupDelegation(input);
        break;
      default:
        respond(response, 404, {
          ok: false,
          error: { message: '接口不存在。' },
        });
        return;
    }
    respond(response, 200, { ok: true, ...result });
  } catch (error) {
    respond(response, 400, {
      ok: false,
      error: { message: String(error?.message || '操作失败。').slice(0, 500) },
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`MFA local API ready on http://${host}:${port}\n`);
});
