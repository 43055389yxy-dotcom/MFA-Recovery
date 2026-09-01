import {
  DescribeAutomationExecutionsCommand,
  DescribeAutomationStepExecutionsCommand,
  GetAutomationExecutionCommand,
  SSMClient,
  type StepExecution,
} from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { credentialsSchema, errorResponse, toCredentials } from '@/lib/aws-server';

export const dynamic = 'force-dynamic';

const statusSchema = credentialsSchema.extend({
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  executionId: z.string().uuid(),
});

const labels: Record<string, string> = {
  assertInstanceIsWindows: '识别目标操作系统',
  runEC2RescueForLinux: '启动 Linux 离线救援',
  runEC2RescueForWindows: '启动 Windows 离线救援',
  getLinuxBackupAmi: '获取 Linux 备份 AMI',
  getLinuxSSHKeyParameter: '保存新的 Linux SSH 私钥',
  getEC2RescueForLinuxResult: '汇总 Linux 恢复结果',
  getWindowsBackupAmi: '获取 Windows 备份 AMI',
  getWindowsPasswordEnabledAmi: '获取可重置密码的 Windows AMI',
  getEC2RescueForWindowsResult: '汇总 Windows 恢复结果',
  describeInstance: '读取目标实例信息',
  describeRootVolume: '读取根 EBS 信息',
  assertRootVolumeIsEbs: '确认根设备为 EBS',
  assertRootVolumeIsNotEncrypted: '检查根 EBS 加密状态',
  createEC2RescueStack: '创建临时救援环境',
  createEC2RescueInstance: '启动临时救援实例',
  waitForEC2RescueInstance: '等待救援实例上线',
  waitForEC2RescueInstanceToBecomeManagedInstance: '等待救援实例接入 Systems Manager',
  stopInstance: '停止目标实例',
  forceStopInstance: '强制停止目标实例',
  createPreEC2RescueBackup: '创建恢复前备份 AMI',
  installEC2Rescue: '安装 EC2Rescue 工具',
  detachRootVolume: '从目标实例拆下根 EBS',
  attachRootVolumeToEC2RescueInstance: '把根 EBS 挂到救援实例',
  runScriptForLinux: '离线注入新的 Linux SSH Key',
  runScriptForWindows: '离线修复 Windows 访问',
  stopEC2RescueInstance: '停止临时救援实例',
  detachRootVolumeFromEC2RescueInstance: '从救援实例卸载根 EBS',
  attachRootVolumeBackToSourceInstance: '把根 EBS 挂回目标实例',
  restoreSourceInstanceState: '恢复目标实例运行状态',
  deleteEC2RescueStack: '清理临时救援资源',
};

function fallbackLabel(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function cleanMessage(message?: string) {
  if (!message) return '';
  return message.replace(/AKIA[A-Z0-9]{12,}/g, '[REDACTED]').slice(0, 500);
}

function mapStep(step: StepExecution, detectedPlatform: 'Linux' | 'Windows' | '') {
  let status: string = step.StepStatus || 'Pending';
  let label = labels[step.StepName || ''] || fallbackLabel(step.StepName || 'AWS 自动化步骤');
  let detail = cleanMessage(step.WarningMessage || step.FailureMessage || step.Response);

  if (step.StepName === 'assertInstanceIsWindows') {
    if (step.StepStatus === 'Failed') {
      status = 'Success';
      label = '已识别为 Linux';
      detail = '目标实例不是 Windows，已进入 Linux 救援流程。';
    } else if (step.StepStatus === 'Success') {
      label = '已识别为 Windows';
      detail = '目标实例是 Windows，已进入 Windows 救援流程。';
    }
  }

  const isLinuxStep = step.StepName?.toLowerCase().includes('linux');
  const isWindowsStep = step.StepName?.toLowerCase().includes('windows');
  if (
    step.StepStatus === 'Pending' &&
    ((detectedPlatform === 'Linux' && isWindowsStep) ||
      (detectedPlatform === 'Windows' && isLinuxStep))
  ) {
    status = 'Skipped';
    detail = `目标实例为 ${detectedPlatform}，此分支无需执行。`;
  }

  return {
    id: step.StepExecutionId || `${step.StepName}-${step.ExecutionStartTime?.getTime() || 0}`,
    name: step.StepName || '',
    label,
    action: step.Action || '',
    status,
    detail,
    startedAt: step.ExecutionStartTime?.toISOString() || '',
    endedAt: step.ExecutionEndTime?.toISOString() || '',
  };
}

async function listSteps(client: SSMClient, executionId: string) {
  const steps: StepExecution[] = [];
  let nextToken: string | undefined;
  do {
    const response = await client.send(
      new DescribeAutomationStepExecutionsCommand({
        AutomationExecutionId: executionId,
        NextToken: nextToken,
        MaxResults: 50,
        ReverseOrder: false,
      }),
    );
    steps.push(...(response.StepExecutions || []));
    nextToken = response.NextToken;
  } while (nextToken);
  return steps;
}

export async function POST(request: Request) {
  try {
    const input = statusSchema.parse(await request.json());
    const client = new SSMClient({
      region: input.region,
      credentials: toCredentials(input),
      maxAttempts: 2,
    });
    const [executionResponse, outerSteps, childResponse] = await Promise.all([
      client.send(new GetAutomationExecutionCommand({ AutomationExecutionId: input.executionId })),
      listSteps(client, input.executionId),
      client.send(
        new DescribeAutomationExecutionsCommand({
          Filters: [{ Key: 'ParentExecutionId', Values: [input.executionId] }],
          MaxResults: 10,
        }),
      ),
    ]);

    const execution = executionResponse.AutomationExecution;
    const assertion = outerSteps.find((step) => step.StepName === 'assertInstanceIsWindows');
    const detectedPlatform: 'Linux' | 'Windows' | '' =
      assertion?.StepStatus === 'Failed'
        ? 'Linux'
        : assertion?.StepStatus === 'Success'
          ? 'Windows'
          : '';

    const children = await Promise.all(
      (childResponse.AutomationExecutionMetadataList || [])
        .filter((child) => child.AutomationExecutionId)
        .map(async (child) => ({
          executionId: child.AutomationExecutionId as string,
          documentName: child.DocumentName || '',
          status: child.AutomationExecutionStatus || 'Pending',
          currentStepName: child.CurrentStepName || '',
          steps: (await listSteps(client, child.AutomationExecutionId as string)).map((step) =>
            mapStep(step, detectedPlatform),
          ),
        })),
    );

    const outputs = execution?.Outputs || {};
    return Response.json({
      ok: true,
      execution: {
        id: execution?.AutomationExecutionId || input.executionId,
        status: execution?.AutomationExecutionStatus || 'Pending',
        statusMessage: cleanMessage(execution?.FailureMessage),
        currentStepName: execution?.CurrentStepName || '',
        currentAction: execution?.CurrentAction || '',
        startedAt: execution?.ExecutionStartTime?.toISOString() || '',
        endedAt: execution?.ExecutionEndTime?.toISOString() || '',
        detectedPlatform,
        steps: outerSteps.map((step) => mapStep(step, detectedPlatform)),
        children,
        result: {
          linuxKeyParameter: outputs['getLinuxSSHKeyParameter.Name']?.[0] || '',
          linuxBackupAmi: outputs['getLinuxBackupAmi.ImageId']?.[0] || '',
          windowsBackupAmi: outputs['getWindowsBackupAmi.ImageId']?.[0] || '',
          windowsPasswordEnabledAmi:
            outputs['getWindowsPasswordEnabledAmi.ImageId']?.[0] || '',
        },
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
