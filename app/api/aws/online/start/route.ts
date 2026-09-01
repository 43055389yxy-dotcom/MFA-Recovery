import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
  errorResponse,
  recoveryTargetSchema,
  toCredentials,
} from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

function linuxRecoveryScript(publicKey: string) {
  const encodedKey = Buffer.from(publicKey, 'utf8').toString('base64');
  return [
    'set -eu',
    `CLOUDRESCUE_KEY_B64='${encodedKey}'`,
    'CLOUDRESCUE_KEY="$(printf %s "$CLOUDRESCUE_KEY_B64" | base64 -d)"',
    'CLOUDRESCUE_USER=""',
    'for candidate in ec2-user ubuntu centos rocky almalinux admin root; do',
    '  if id "$candidate" >/dev/null 2>&1; then CLOUDRESCUE_USER="$candidate"; break; fi',
    'done',
    'if [ -z "$CLOUDRESCUE_USER" ]; then echo "未找到受支持的登录用户" >&2; exit 20; fi',
    'CLOUDRESCUE_HOME="$(getent passwd "$CLOUDRESCUE_USER" | cut -d: -f6)"',
    'if [ -z "$CLOUDRESCUE_HOME" ] || [ ! -d "$CLOUDRESCUE_HOME" ]; then echo "用户主目录不存在" >&2; exit 21; fi',
    'CLOUDRESCUE_GROUP="$(id -gn "$CLOUDRESCUE_USER")"',
    'CLOUDRESCUE_SSH_DIR="$CLOUDRESCUE_HOME/.ssh"',
    'CLOUDRESCUE_KEYS="$CLOUDRESCUE_SSH_DIR/authorized_keys"',
    'install -d -m 700 -o "$CLOUDRESCUE_USER" -g "$CLOUDRESCUE_GROUP" "$CLOUDRESCUE_SSH_DIR"',
    'if [ -f "$CLOUDRESCUE_KEYS" ]; then cp -p "$CLOUDRESCUE_KEYS" "$CLOUDRESCUE_KEYS.cloudrescue.$(date +%Y%m%d%H%M%S).bak"; fi',
    'touch "$CLOUDRESCUE_KEYS"',
    'if ! grep -qxF "$CLOUDRESCUE_KEY" "$CLOUDRESCUE_KEYS"; then printf "%s\\n" "$CLOUDRESCUE_KEY" >> "$CLOUDRESCUE_KEYS"; fi',
    'chown "$CLOUDRESCUE_USER:$CLOUDRESCUE_GROUP" "$CLOUDRESCUE_KEYS"',
    'chmod 700 "$CLOUDRESCUE_SSH_DIR"',
    'chmod 600 "$CLOUDRESCUE_KEYS"',
    'if command -v restorecon >/dev/null 2>&1; then restorecon -RF "$CLOUDRESCUE_SSH_DIR" || true; fi',
    'if command -v sshd >/dev/null 2>&1; then sshd -t; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl is-active sshd >/dev/null 2>&1 || systemctl is-active ssh >/dev/null 2>&1 || true; fi',
    'echo "CLOUDRESCUE_RESULT=SUCCESS"',
    'echo "CLOUDRESCUE_USER=$CLOUDRESCUE_USER"',
    'echo "authorized_keys 已备份并写入新公钥，目录权限与所有者已修复。"',
  ];
}

function windowsRecoveryScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$administrator = Get-LocalUser -Name 'Administrator' -ErrorAction SilentlyContinue",
    "if (-not $administrator) { throw '未找到 Administrator 本地用户' }",
    "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0",
    "Set-Service -Name TermService -StartupType Automatic",
    "if ((Get-Service -Name TermService).Status -ne 'Running') { Start-Service -Name TermService }",
    "Get-NetFirewallRule -Name 'RemoteDesktop*' -ErrorAction SilentlyContinue | Enable-NetFirewallRule",
    "$launch = Get-Service -Name 'Ec2Launch','Ec2LaunchV2','EC2Config' -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType",
    "$rdp = Get-Service -Name TermService | Select-Object Name,Status,StartType",
    "Write-Output 'CLOUDRESCUE_RESULT=SUCCESS'",
    "$rdp | ConvertTo-Json -Compress | Write-Output",
    "$launch | ConvertTo-Json -Compress | Write-Output",
  ];
}

export async function POST(request: Request) {
  try {
    const input = recoveryTargetSchema.parse(await request.json());
    const credentials = toCredentials(input);
    const ec2 = new EC2Client({ region: input.region, credentials, maxAttempts: 2 });
    const described = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [input.instanceId] }),
    );
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error('没有找到该 EC2 实例。');

    const platform: 'Linux' | 'Windows' =
      instance.Platform === 'Windows' ? 'Windows' : 'Linux';
    if (platform === 'Linux' && !input.sshPublicKey) {
      return Response.json(
        {
          ok: false,
          error: { code: 'SSH_KEY_REQUIRED', message: 'Linux 在线恢复需要新的 SSH 公钥。' },
        },
        { status: 400 },
      );
    }

    const client = new SSMClient({ region: input.region, credentials, maxAttempts: 2 });
    const response = await client.send(
      new SendCommandCommand({
        InstanceIds: [input.instanceId],
        DocumentName:
          platform === 'Windows' ? 'AWS-RunPowerShellScript' : 'AWS-RunShellScript',
        Comment: 'CloudRescue online access recovery',
        TimeoutSeconds: 600,
        Parameters: {
          commands:
            platform === 'Windows'
              ? windowsRecoveryScript()
              : linuxRecoveryScript(input.sshPublicKey as string),
          executionTimeout: ['600'],
        },
      }),
    );

    return Response.json({
      ok: true,
      run: {
        id: response.Command?.CommandId || '',
        kind: 'command',
        strategy: 'ssm-online',
        platform,
        instanceId: input.instanceId,
        region: input.region,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
