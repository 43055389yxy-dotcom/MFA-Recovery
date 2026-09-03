import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.MFA_API_PORT || '3198', 10);
const host = process.env.MFA_API_HOST || '127.0.0.1';
const awsCliPath = process.env.AWS_CLI_PATH || '/usr/local/bin/aws';
const legacyPayerProfilesService = 'mfa-recovery-payer-profiles';
const legacyPayerProfilesAccount = 'profiles';
const storageService = 'mfa-recovery-storage';
let cachedStorageConfig;
let legacyMigrationComplete = false;

function validateInput(input) {
  validateCredentialsInput(input);
  if (!/^\d{12}$/.test(String(input.accountId || ''))) {
    throw new Error('目标账号 ID 必须是 12 位数字。');
  }
}

function validateCredentialsInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请求内容不正确。');
  if (!/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(String(input.accessKeyId || ''))) {
    throw new Error('Access Key ID 格式不正确。');
  }
  if (String(input.secretAccessKey || '').length < 30) {
    throw new Error('Secret Access Key 格式不正确。');
  }
}

function validatePrimaryEmail(input) {
  const primaryEmail = String(input.primaryEmail || '').trim();
  if (
    primaryEmail.length < 5 ||
    primaryEmail.length > 64 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primaryEmail)
  ) {
    throw new Error('新根邮箱格式不正确。');
  }
  return primaryEmail;
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
  } else {
    delete environment.AWS_ACCESS_KEY_ID;
    delete environment.AWS_SECRET_ACCESS_KEY;
    delete environment.AWS_SESSION_TOKEN;
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

async function deleteKeychainSecret(service, account) {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password',
      '-a',
      account,
      '-s',
      service,
    ]);
  } catch (error) {
    if (
      !/could not be found|item not found/i.test(String(error?.stderr || ''))
    ) {
      throw error;
    }
  }
}

async function readLegacyPayerProfiles() {
  try {
    const value = await keychainSecret(
      legacyPayerProfilesService,
      legacyPayerProfilesAccount,
    );
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readLegacyTestCredentials() {
  const [accessKeyId, secretAccessKey, accountId] = await Promise.all([
    keychainSecret('mfa-recovery-test-payer', 'access-key-id'),
    keychainSecret('mfa-recovery-test-payer', 'secret-access-key'),
    keychainSecret('mfa-recovery-test-payer', 'target-account-id'),
  ]);
  return { accessKeyId, secretAccessKey, accountId };
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
    environmentConfig.kmsKeyId,
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

async function encryptProfileCredentials(profile) {
  const config = await storageConfig();
  const plaintext = Buffer.from(
    JSON.stringify({
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      ...(profile.sessionToken ? { sessionToken: profile.sessionToken } : {}),
    }),
    'utf8',
  ).toString('base64');
  const result = await storageAws([
    'kms',
    'encrypt',
    '--key-id',
    config.kmsKeyId,
    '--plaintext',
    plaintext,
    '--encryption-context',
    `profileId=${profile.id}`,
  ]);
  if (!result.CiphertextBlob) throw new Error('代付账号凭证加密失败。');
  return result.CiphertextBlob;
}

async function decryptProfileCredentials(profileId, ciphertext) {
  const result = await storageAws([
    'kms',
    'decrypt',
    '--ciphertext-blob',
    ciphertext,
    '--encryption-context',
    `profileId=${profileId}`,
  ]);
  if (!result.Plaintext) throw new Error('代付账号凭证解密失败。');
  return JSON.parse(Buffer.from(result.Plaintext, 'base64').toString('utf8'));
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
  const profiles = await Promise.all(
    (result.Items || []).map(async (item) => {
      const id = dynamoString(item, config.partitionKey);
      const credentialsCiphertext = dynamoString(item, 'credentialsCiphertext');
      const credentials = credentialsCiphertext
        ? await decryptProfileCredentials(id, credentialsCiphertext)
        : null;
      return {
        id,
        accountId: dynamoString(item, 'accountId'),
        callerArn: dynamoString(item, 'callerArn'),
        label: dynamoString(item, 'label'),
        accessKeyId: credentials?.accessKeyId || '',
        secretAccessKey: credentials?.secretAccessKey || '',
        ...(credentials?.sessionToken
          ? { sessionToken: credentials.sessionToken }
          : {}),
        credentialStatus: credentials ? 'ready' : 'missing',
        lastTargetAccountId: '',
        source: 'saved',
        addedAt: dynamoString(item, 'addedAt'),
        updatedAt: dynamoString(item, 'updatedAt'),
      };
    }),
  );
  return profiles.sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt)),
  );
}

async function putDynamoProfile(profile) {
  const config = await storageConfig();
  const hasCredentials = Boolean(
    profile.accessKeyId && profile.secretAccessKey,
  );
  const item = {
    [config.partitionKey]: { S: profile.id },
    accountId: { S: profile.accountId },
    callerArn: { S: profile.callerArn || '' },
    label: { S: profile.label || `代付账号 ${profile.accountId}` },
    credentialStatus: { S: hasCredentials ? 'ready' : 'missing' },
    lastTargetAccountId: { S: '' },
    source: { S: 'saved' },
    addedAt: { S: profile.addedAt || new Date().toISOString() },
    updatedAt: { S: profile.updatedAt || new Date().toISOString() },
  };
  if (hasCredentials) {
    item.credentialsCiphertext = {
      S: await encryptProfileCredentials(profile),
    };
  }
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

async function clearLegacyProfiles() {
  await Promise.all([
    deleteKeychainSecret(
      legacyPayerProfilesService,
      legacyPayerProfilesAccount,
    ),
    deleteKeychainSecret('mfa-recovery-test-payer', 'access-key-id'),
    deleteKeychainSecret('mfa-recovery-test-payer', 'secret-access-key'),
    deleteKeychainSecret('mfa-recovery-test-payer', 'target-account-id'),
  ]);
}

async function migrateLegacyProfiles() {
  if (legacyMigrationComplete) return;
  const remoteProfiles = await readDynamoProfiles();
  const legacyProfiles = await readLegacyPayerProfiles();
  try {
    const credentials = await readLegacyTestCredentials();
    const caller = await aws(credentials, ['sts', 'get-caller-identity']);
    if (
      caller.Account &&
      !legacyProfiles.some((profile) => profile.accountId === caller.Account)
    ) {
      const now = new Date().toISOString();
      legacyProfiles.push({
        id: `payer:${caller.Account}`,
        accountId: caller.Account,
        callerArn: caller.Arn || '',
        label: `代付账号 ${caller.Account}`,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        lastTargetAccountId: credentials.accountId,
        source: 'saved',
        addedAt: now,
        updatedAt: now,
      });
    }
  } catch {
    // 没有旧测试凭证时无需迁移。
  }

  for (const profile of legacyProfiles) {
    if (
      !remoteProfiles.some((remote) => remote.accountId === profile.accountId)
    ) {
      await putDynamoProfile({
        ...profile,
        id: `payer:${profile.accountId}`,
        source: 'saved',
      });
    }
  }
  await clearLegacyProfiles();
  legacyMigrationComplete = true;
}

async function readPayerProfiles() {
  await migrateLegacyProfiles();
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
  const credentialsReady = Boolean(
    profile.accessKeyId && profile.secretAccessKey,
  );
  return {
    id: profile.id,
    accountId: profile.accountId,
    label: profile.label || `代付账号 ${profile.accountId}`,
    accessKeyMask: credentialsReady
      ? `${profile.accessKeyId.slice(0, 4)}••••${profile.accessKeyId.slice(-4)}`
      : '待补充凭证',
    credentialStatus: credentialsReady ? 'ready' : 'missing',
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
    label: requestedLabel || existing?.label || `代付账号 ${caller.Account}`,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
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

async function resolveInput(input) {
  if (input?.profileId) {
    const profiles = await readPayerProfiles();
    const profile = profiles.find(
      (candidate) => candidate.id === input.profileId,
    );
    if (!profile) throw new Error('没有找到已保存的代付账号。');
    if (!profile.accessKeyId || !profile.secretAccessKey) {
      throw new Error('该账号已保留，请先补充 AK/SK 后再开始恢复。');
    }
    return {
      ...input,
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      accountId: input.accountId || profile.lastTargetAccountId,
    };
  }
  return input;
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function cloudShellCommand(lines) {
  return [...lines, '', ''].join('\n');
}

function permissionInstructions(callerArn) {
  const administratorPolicyArn = 'arn:aws:iam::aws:policy/AdministratorAccess';
  if (/:user\//.test(callerArn)) {
    const userName = callerArn.split('/').at(-1);
    return {
      principal: `IAM 用户 ${userName}`,
      requiresNewCredentials: false,
      command: cloudShellCommand([
        'aws iam attach-user-policy \\',
        `  --user-name ${shellQuote(userName)} \\`,
        `  --policy-arn ${administratorPolicyArn}`,
        'aws organizations enable-aws-service-access --service-principal account.amazonaws.com',
      ]),
    };
  }

  if (/:assumed-role\//.test(callerArn)) {
    const roleName = callerArn.split(':assumed-role/')[1]?.split('/')[0] || '';
    return {
      principal: `IAM 角色 ${roleName}`,
      requiresNewCredentials: false,
      command: cloudShellCommand([
        'aws iam attach-role-policy \\',
        `  --role-name ${shellQuote(roleName)} \\`,
        `  --policy-arn ${administratorPolicyArn}`,
        'aws organizations enable-aws-service-access --service-principal account.amazonaws.com',
      ]),
    };
  }

  if (/:role\//.test(callerArn)) {
    const roleName = callerArn.split('/').at(-1);
    return {
      principal: `IAM 角色 ${roleName}`,
      requiresNewCredentials: false,
      command: cloudShellCommand([
        'aws iam attach-role-policy \\',
        `  --role-name ${shellQuote(roleName)} \\`,
        `  --policy-arn ${administratorPolicyArn}`,
        'aws organizations enable-aws-service-access --service-principal account.amazonaws.com',
      ]),
    };
  }

  if (callerArn.endsWith(':root')) {
    return {
      principal: '根用户访问密钥',
      requiresNewCredentials: true,
      command: cloudShellCommand([
        "USER_NAME='MfaRecoveryOperator'",
        `POLICY_ARN=${shellQuote(administratorPolicyArn)}`,
        'aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || aws iam create-user --user-name "$USER_NAME"',
        'for KEY_ID in $(aws iam list-access-keys --user-name "$USER_NAME" --query \'AccessKeyMetadata[].AccessKeyId\' --output text); do',
        '  [ "$KEY_ID" = "None" ] || aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$KEY_ID"',
        'done',
        'aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"',
        'aws organizations enable-aws-service-access --service-principal account.amazonaws.com',
        'aws iam create-access-key --user-name "$USER_NAME" --output json',
      ]),
    };
  }

  return {
    principal: callerArn,
    requiresNewCredentials: false,
    command: cloudShellCommand([
      `请在 IAM 中为 ${callerArn} 添加 AdministratorAccess 权限。`,
    ]),
  };
}

function isPermissionError(error) {
  return /AccessDenied|not authorized|UnauthorizedOperation|lacks permissions|permission/i.test(
    String(error?.message || ''),
  );
}

async function registerPayerAccount(input) {
  validateCredentialsInput(input);
  const caller = await aws(input, ['sts', 'get-caller-identity']);
  if (!caller.Account || !caller.Arn) throw new Error('无法识别执行账号。');

  const instructions = permissionInstructions(caller.Arn);
  if (instructions.requiresNewCredentials) {
    return {
      ready: false,
      caller: { accountId: caller.Account, arn: caller.Arn },
      ...instructions,
    };
  }

  try {
    let policies = [];
    if (/:user\//.test(caller.Arn)) {
      const userName = caller.Arn.split('/').at(-1);
      const result = await aws(input, [
        'iam',
        'list-attached-user-policies',
        '--user-name',
        userName,
      ]);
      policies = result.AttachedPolicies || [];
    } else {
      const roleName = caller.Arn.includes(':assumed-role/')
        ? caller.Arn.split(':assumed-role/')[1]?.split('/')[0]
        : caller.Arn.split('/').at(-1);
      const result = await aws(input, [
        'iam',
        'list-attached-role-policies',
        '--role-name',
        roleName,
      ]);
      policies = result.AttachedPolicies || [];
    }

    const hasAdministratorAccess = policies.some(
      (policy) =>
        policy.PolicyArn === 'arn:aws:iam::aws:policy/AdministratorAccess',
    );
    if (!hasAdministratorAccess) {
      return {
        ready: false,
        caller: { accountId: caller.Account, arn: caller.Arn },
        ...instructions,
      };
    }
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    return {
      ready: false,
      caller: { accountId: caller.Account, arn: caller.Arn },
      ...instructions,
    };
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
  const instructions = permissionInstructions(caller.Arn);

  if (instructions.requiresNewCredentials) {
    return {
      ready: false,
      caller: { accountId: caller.Account, arn: caller.Arn },
      ...instructions,
    };
  }

  try {
    const status = await preflight(input);
    const stored = input.profileId?.startsWith('payer:')
      ? (await readPayerProfiles()).find(
          (candidate) => candidate.id === input.profileId,
        )
      : null;
    const profile = stored
      ? publicPayerProfile(stored)
      : publicPayerProfile({
          id: input.profileId,
          accountId: caller.Account,
          label: `代付账号 ${caller.Account}`,
          accessKeyId: input.accessKeyId,
          lastTargetAccountId: input.accountId,
          source: 'saved',
        });
    return { ready: true, profile, preflight: status };
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    return {
      ready: false,
      caller: { accountId: caller.Account, arn: caller.Arn },
      ...instructions,
    };
  }
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

async function ensureAccountManagementAccess(input) {
  const serviceAccess = await aws(input, [
    'organizations',
    'list-aws-service-access-for-organization',
  ]);
  const enabled = serviceAccess.EnabledServicePrincipals?.some(
    (service) => service.ServicePrincipal === 'account.amazonaws.com',
  );
  if (enabled) return;
  await aws(input, [
    'organizations',
    'enable-aws-service-access',
    '--service-principal',
    'account.amazonaws.com',
  ]);
}

async function startPrimaryEmailUpdate(input) {
  validateInput(input);
  const primaryEmail = validatePrimaryEmail(input);
  await ensureAccountManagementAccess(input);
  const result = await aws(input, [
    'account',
    'start-primary-email-update',
    '--region',
    'us-east-1',
    '--account-id',
    input.accountId,
    '--primary-email',
    primaryEmail,
  ]);
  return { emailStatus: result.Status || 'PENDING', primaryEmail };
}

async function acceptPrimaryEmailUpdate(input) {
  validateInput(input);
  const primaryEmail = validatePrimaryEmail(input);
  const otp = String(input.otp || '').trim();
  if (!/^[A-Za-z0-9]{6}$/.test(otp)) {
    throw new Error('验证码必须为 6 位字符。');
  }
  await aws(input, [
    'account',
    'accept-primary-email-update',
    '--region',
    'us-east-1',
    '--account-id',
    input.accountId,
    '--primary-email',
    primaryEmail,
    '--otp',
    otp,
  ]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await aws(input, [
      'account',
      'get-primary-email',
      '--region',
      'us-east-1',
      '--account-id',
      input.accountId,
    ]);
    if (
      String(current.PrimaryEmail || '').toLowerCase() ===
      primaryEmail.toLowerCase()
    ) {
      return { emailStatus: 'COMPLETED', primaryEmail };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('根邮箱更新尚未生效，请稍后重试。');
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
      case '/api/aws/mfa/root/status':
        result = await auditRootCredentials(input);
        break;
      case '/api/aws/mfa/root/delete':
        result = await deleteRootCredentials(input);
        break;
      case '/api/aws/mfa/root/recover':
        result = await allowPasswordRecovery(input);
        break;
      case '/api/aws/mfa/email/start':
        result = await startPrimaryEmailUpdate(input);
        break;
      case '/api/aws/mfa/email/accept':
        result = await acceptPrimaryEmailUpdate(input);
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
