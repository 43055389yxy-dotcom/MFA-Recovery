'use client';

// oxlint-disable react/react-compiler

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clipboard,
  CloudCog,
  FileKey2,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Network,
  Radar,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SkipForward,
  TerminalSquare,
  Trash2,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

type Credentials = { accessKeyId: string; secretAccessKey: string };
type Account = { id: string; arn: string; partition: string };

type Instance = {
  id: string;
  region: string;
  name: string;
  type: string;
  state: string;
  platform: 'Linux' | 'Windows';
  platformDetails: string;
  architecture: string;
  availabilityZone: string;
  publicIp: string;
  privateIp: string;
  keyName: string;
  rootDeviceType: string;
  launchTime: string;
};

type Assessment = {
  instance: {
    id: string;
    name: string;
    region: string;
    state: string;
    platform: 'Linux' | 'Windows';
    platformDetails: string;
    architecture: string;
    imageId: string;
    imageName: string;
    instanceType: string;
    availabilityZone: string;
    vpcId: string;
    subnetId: string;
    securityGroups: { id: string; name: string }[];
    publicIp: string;
    privateIp: string;
    elasticIp: string;
    iamInstanceProfile: string;
    keyName: string;
    rootDeviceType: string;
    rootVolumeId: string;
    rootVolumeEncrypted: boolean;
    kmsKeyId: string;
    autoScalingGroupName: string;
    hasInstanceStore: boolean;
    isMarketplace: boolean;
  };
  ssm: {
    managed: boolean;
    pingStatus: string;
    platformName: string;
    platformVersion: string;
    agentVersion: string;
    lastPingAt: string;
    online: boolean;
  };
  statusChecks: { system: string; instance: string; ebs: string };
  network: {
    port: number;
    portRulePresent: boolean;
    instanceConnectEndpointId: string;
    instanceConnectEndpointState: string;
  };
  strategies: {
    ssm: { available: boolean; reason: string };
    instanceConnect: {
      applicable: boolean;
      available: boolean;
      confidence: string;
      osHintSupported: boolean;
      networkPath: boolean;
      reason: string;
    };
    troubleshoot: { available: boolean; document: string; reason: string };
    offline: { available: boolean; requiresStop: boolean; warnings: string[] };
  };
};

type ExecutionStep = {
  id: string;
  name: string;
  label: string;
  action: string;
  status: string;
  detail: string;
  startedAt: string;
  endedAt: string;
};

type AutomationExecution = {
  id: string;
  documentName: string;
  status: string;
  statusMessage: string;
  currentStepName: string;
  currentAction: string;
  startedAt: string;
  endedAt: string;
  detectedPlatform: 'Linux' | 'Windows' | '';
  steps: ExecutionStep[];
  children: {
    executionId: string;
    documentName: string;
    status: string;
    currentStepName: string;
    steps: ExecutionStep[];
  }[];
  result: {
    linuxKeyParameter: string;
    linuxBackupAmi: string;
    windowsBackupAmi: string;
    windowsPasswordEnabledAmi: string;
    ec2RescueResult: string;
  };
};

type CommandExecution = {
  id?: string;
  status: string;
  statusDetails: string;
  responseCode: number | null;
  startedAt?: string;
  endedAt?: string;
  elapsed?: string;
  stdout: string;
  stderr: string;
};

type Run = {
  id: string;
  kind: 'command' | 'automation';
  strategy: 'ssm-online' | 'online-troubleshoot' | 'offline-reset';
  documentName?: string;
};

type Strategy =
  | 'ssm'
  | 'eic'
  | 'existing'
  | 'troubleshoot'
  | 'offline'
  | 'done';

type Attempt = {
  strategy: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
  id?: string;
};

type Verification = {
  instanceId: string;
  state: string;
  platform: 'Linux' | 'Windows';
  publicIp: string;
  publicIpChanged: boolean;
  elasticIp: string;
  statusChecks: { system: string; instance: string; ebs: string };
  ssmPingStatus: string;
  remotePort: number;
  remotePortSecurityGroupRule: boolean;
  note: string;
};

const stages = [
  { id: 1, label: '连接账号', detail: '验证 AK/SK' },
  { id: 2, label: '智能诊断', detail: '读取实例与可用路径' },
  { id: 3, label: '执行恢复', detail: '优先在线，逐级降级' },
  { id: 4, label: '验证结果', detail: '复查状态与输出' },
];

const automationTerminal = new Set([
  'Success',
  'Failed',
  'TimedOut',
  'Cancelled',
  'Exited',
  'CompletedWithSuccess',
  'CompletedWithFailure',
  'Rejected',
]);
const automationSuccess = new Set(['Success', 'CompletedWithSuccess']);
const commandTerminal = new Set([
  'Success',
  'Failed',
  'Cancelled',
  'TimedOut',
  'Delivery Timed Out',
  'Execution Timed Out',
  'Undeliverable',
  'Terminated',
]);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || '请求失败，请稍后重试。');
  return data;
}

function statusText(status: string) {
  const values: Record<string, string> = {
    Pending: '等待中',
    InProgress: '进行中',
    'In Progress': '进行中',
    Waiting: '等待中',
    Delayed: '分发延迟',
    Success: '已完成',
    CompletedWithSuccess: '已完成',
    CompletedWithFailure: '失败',
    Skipped: '已跳过',
    Failed: '失败',
    TimedOut: '超时',
    'Delivery Timed Out': '分发超时',
    'Execution Timed Out': '执行超时',
    Cancelled: '已取消',
    Cancelling: '取消中',
    Undeliverable: '无法送达',
    Terminated: '已终止',
  };
  return values[status] || status;
}

function statusColor(status: string) {
  if (status === 'Success' || status === 'CompletedWithSuccess') {
    return 'bg-emerald-50 text-emerald-700';
  }
  if (status === 'InProgress' || status === 'In Progress' || status === 'Waiting') {
    return 'bg-amber-50 text-amber-700';
  }
  if (
    status === 'Failed' ||
    status === 'TimedOut' ||
    status.includes('Timed Out') ||
    status === 'CompletedWithFailure'
  ) {
    return 'bg-red-50 text-red-700';
  }
  return 'bg-slate-100 text-slate-500';
}

function StepIcon({ status }: { status: string }) {
  if (status === 'Success' || status === 'CompletedWithSuccess') {
    return <CheckCircle2 className="size-4 text-emerald-600" />;
  }
  if (status === 'Skipped') return <SkipForward className="size-4 text-slate-400" />;
  if (status === 'InProgress' || status === 'In Progress' || status === 'Waiting') {
    return <LoaderCircle className="size-4 animate-spin text-[#d97808]" />;
  }
  if (
    status === 'Failed' ||
    status === 'TimedOut' ||
    status.includes('Timed Out') ||
    status === 'CompletedWithFailure'
  ) {
    return <XCircle className="size-4 text-red-600" />;
  }
  return <Circle className="size-4 text-slate-300" />;
}

function StepRow({ step, nested = false }: { step: ExecutionStep; nested?: boolean }) {
  return (
    <div className={`relative flex gap-3 ${nested ? 'py-2.5' : 'py-3.5'}`}>
      <span className="relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-card">
        <StepIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`${nested ? 'text-xs' : 'text-sm'} font-medium text-slate-800`}>
            {step.label}
          </p>
          <Badge className={statusColor(step.status)} variant="secondary">
            {statusText(step.status)}
          </Badge>
        </div>
        {step.detail ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>
        ) : null}
        {step.startedAt ? (
          <p className="mt-1 font-mono text-[10px] text-slate-400">
            {new Date(step.startedAt).toLocaleTimeString('zh-CN')}
            {step.endedAt
              ? ` — ${new Date(step.endedAt).toLocaleTimeString('zh-CN')}`
              : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function defaultOsUser(assessment: Assessment) {
  const value =
    `${assessment.ssm.platformName} ${assessment.instance.imageName}`.toLowerCase();
  if (value.includes('ubuntu')) return 'ubuntu';
  if (value.includes('centos')) return 'centos';
  if (value.includes('rocky')) return 'rocky';
  if (value.includes('alma')) return 'almalinux';
  if (value.includes('debian')) return 'admin';
  return 'ec2-user';
}

function firstStrategy(assessment: Assessment): Strategy {
  if (assessment.strategies.ssm.available) return 'ssm';
  if (assessment.strategies.instanceConnect.available) return 'eic';
  return 'existing';
}

export default function Home() {
  const [stage, setStage] = useState(1);
  const [credentials, setCredentials] = useState<Credentials>({
    accessKeyId: '',
    secretAccessKey: '',
  });
  const [showSecret, setShowSecret] = useState(false);
  const [cloudShellCommand, setCloudShellCommand] = useState(
    'curl -fsSL https://YOUR-SITE/setup.sh | bash',
  );
  const [copied, setCopied] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [scanWarnings, setScanWarnings] = useState<{ region: string; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const [directRegion, setDirectRegion] = useState('us-east-1');
  const [directInstanceId, setDirectInstanceId] = useState('');
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [assessmentLoading, setAssessmentLoading] = useState(false);
  const [sshPublicKey, setSshPublicKey] = useState('');
  const [osUser, setOsUser] = useState('ec2-user');
  const [activeStrategy, setActiveStrategy] = useState<Strategy>('ssm');
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [command, setCommand] = useState<CommandExecution | null>(null);
  const [execution, setExecution] = useState<AutomationExecution | null>(null);
  const [temporaryAccess, setTemporaryAccess] = useState<{
    osUser: string;
    publicIp: string;
    privateIp: string;
    expiresAt: string;
    validForSeconds: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [offlineConfirmed, setOfflineConfirmed] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [finalMethod, setFinalMethod] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const handledRun = useRef('');

  useEffect(() => {
    setCloudShellCommand(`curl -fsSL ${window.location.origin}/setup.sh | bash`);
  }, []);

  useEffect(() => {
    if (!temporaryAccess) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [temporaryAccess]);

  const copyText = useCallback(async (id: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(''), 1600);
  }, []);

  const filteredInstances = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return instances.filter((instance) => {
      const regionMatches = regionFilter === 'all' || instance.region === regionFilter;
      const searchMatches =
        !keyword ||
        [instance.name, instance.id, instance.publicIp, instance.privateIp, instance.region]
          .join(' ')
          .toLowerCase()
          .includes(keyword);
      return regionMatches && searchMatches;
    });
  }, [instances, regionFilter, search]);

  const remainingSeconds = temporaryAccess
    ? Math.max(0, Math.ceil((new Date(temporaryAccess.expiresAt).getTime() - now) / 1000))
    : 0;

  async function scanAccount(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await postJson<{
        ok: true;
        account: Account;
        regions: string[];
        instances: Instance[];
        warnings: { region: string; message: string }[];
      }>('/api/aws/scan', credentials);
      setAccount(result.account);
      setRegions(result.regions);
      setInstances(result.instances);
      setScanWarnings(result.warnings);
      setDirectRegion(result.regions.includes('us-east-1') ? 'us-east-1' : result.regions[0] || '');
      setStage(2);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '账号连接失败。');
    } finally {
      setLoading(false);
    }
  }

  async function loadAssessment(region: string, instanceId: string, source?: Instance) {
    setError('');
    setAssessment(null);
    setAssessmentLoading(true);
    try {
      const result = await postJson<{ ok: true; assessment: Assessment }>('/api/aws/preflight', {
        ...credentials,
        region,
        instanceId,
      });
      const value = result.assessment;
      setAssessment(value);
      setSelectedInstance(
        source || {
          id: value.instance.id,
          region: value.instance.region,
          name: value.instance.name,
          type: value.instance.instanceType,
          state: value.instance.state,
          platform: value.instance.platform,
          platformDetails: value.instance.platformDetails,
          architecture: value.instance.architecture,
          availabilityZone: value.instance.availabilityZone,
          publicIp: value.instance.publicIp,
          privateIp: value.instance.privateIp,
          keyName: value.instance.keyName,
          rootDeviceType: value.instance.rootDeviceType,
          launchTime: '',
        },
      );
      setOsUser(defaultOsUser(value));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '实例诊断失败。');
    } finally {
      setAssessmentLoading(false);
    }
  }

  function beginRecovery() {
    if (!assessment) return;
    if (assessment.instance.platform === 'Linux' && !sshPublicKey.trim()) {
      setError('Linux 恢复需要输入与现有私钥配套的新 SSH 公钥。');
      return;
    }
    setError('');
    setAttempts([]);
    setRun(null);
    setCommand(null);
    setExecution(null);
    setVerification(null);
    setActiveStrategy(firstStrategy(assessment));
    setStage(3);
  }

  async function startOnline() {
    if (!assessment) return;
    setLoading(true);
    setError('');
    setCommand(null);
    setExecution(null);
    try {
      const result = await postJson<{ ok: true; run: Run }>('/api/aws/online/start', {
        ...credentials,
        region: assessment.instance.region,
        instanceId: assessment.instance.id,
        sshPublicKey:
          assessment.instance.platform === 'Linux' ? sshPublicKey.trim() : undefined,
      });
      handledRun.current = '';
      setRun(result.run);
    } catch (requestError) {
      const failureMessage =
        requestError instanceof Error ? requestError.message : 'SSM 在线恢复启动失败。';
      setAttempts([
        ...attempts,
        { strategy: 'SSM 不停机恢复', status: 'failed', message: failureMessage },
      ]);
      setActiveStrategy(
        assessment.strategies.instanceConnect.available ? 'eic' : 'existing',
      );
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  }

  async function pushInstanceConnectKey() {
    if (!assessment) return;
    setLoading(true);
    setError('');
    try {
      const result = await postJson<{
        ok: true;
        temporaryAccess: {
          osUser: string;
          publicIp: string;
          privateIp: string;
          expiresAt: string;
          validForSeconds: number;
        };
      }>('/api/aws/eic/push', {
        ...credentials,
        region: assessment.instance.region,
        instanceId: assessment.instance.id,
        sshPublicKey: sshPublicKey.trim(),
        osUser,
      });
      setTemporaryAccess(result.temporaryAccess);
      setAttempts((value) => [
        ...value,
        {
          strategy: 'EC2 Instance Connect',
          status: 'success',
          message: 'AWS 已接受公钥，临时登录窗口为 60 秒。',
        },
      ]);
    } catch (requestError) {
      const failureMessage =
        requestError instanceof Error ? requestError.message : '临时公钥推送失败。';
      setAttempts([
        ...attempts,
        {
          strategy: 'EC2 Instance Connect',
          status: 'failed',
          message: failureMessage,
        },
      ]);
      setActiveStrategy('existing');
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  }

  async function startTroubleshoot() {
    if (!assessment) return;
    setLoading(true);
    setError('');
    setCommand(null);
    setExecution(null);
    try {
      const result = await postJson<{ ok: true; run: Run }>(
        '/api/aws/troubleshoot/start',
        {
          ...credentials,
          region: assessment.instance.region,
          instanceId: assessment.instance.id,
        },
      );
      handledRun.current = '';
      setRun(result.run);
    } catch (requestError) {
      const failureMessage =
        requestError instanceof Error ? requestError.message : '官方在线排障启动失败。';
      setAttempts([
        ...attempts,
        {
          strategy: 'AWS 官方在线排障',
          status: 'failed',
          message: failureMessage,
        },
      ]);
      setActiveStrategy('offline');
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  }

  async function startOffline() {
    if (!assessment || !offlineConfirmed) return;
    setLoading(true);
    setError('');
    setCommand(null);
    setExecution(null);
    try {
      const result = await postJson<{ ok: true; executionId: string }>(
        '/api/aws/start',
        {
          ...credentials,
          region: assessment.instance.region,
          instanceId: assessment.instance.id,
          encrypted: assessment.instance.rootVolumeEncrypted,
          subnetId: 'CreateNewVPC',
          confirmed: true,
        },
      );
      handledRun.current = '';
      setRun({
        id: result.executionId,
        kind: 'automation',
        strategy: 'offline-reset',
        documentName: 'AWSSupport-ResetAccess',
      });
    } catch (requestError) {
      const failureMessage =
        requestError instanceof Error ? requestError.message : '离线恢复启动失败。';
      setAttempts([
        ...attempts,
        {
          strategy: 'AWSSupport-ResetAccess',
          status: 'failed',
          message: failureMessage,
        },
      ]);
      setError(failureMessage);
    } finally {
      setLoading(false);
    }
  }

  const refreshRun = useCallback(async () => {
    if (!run || !assessment) return;
    try {
      if (run.kind === 'command') {
        const result = await postJson<{ ok: true; command: CommandExecution }>(
          '/api/aws/command/status',
          {
            ...credentials,
            region: assessment.instance.region,
            instanceId: assessment.instance.id,
            commandId: run.id,
          },
        );
        setCommand(result.command);
      } else {
        const result = await postJson<{ ok: true; execution: AutomationExecution }>(
          '/api/aws/status',
          {
            ...credentials,
            region: assessment.instance.region,
            executionId: run.id,
          },
        );
        setExecution(result.execution);
      }
      setLastUpdated(new Date());
      setError('');
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : '获取执行进度失败。',
      );
    }
  }, [assessment, credentials, run]);

  useEffect(() => {
    if (!run) return;
    void refreshRun();
    const status = run.kind === 'command' ? command?.status : execution?.status;
    const terminal =
      run.kind === 'command'
        ? Boolean(status && commandTerminal.has(status))
        : Boolean(status && automationTerminal.has(status));
    if (terminal) return;
    const timer = window.setInterval(() => void refreshRun(), 4_000);
    return () => window.clearInterval(timer);
  }, [command?.status, execution?.status, refreshRun, run]);

  async function verifyAndFinish(method: string) {
    if (!assessment) return;
    try {
      const result = await postJson<{ ok: true; verification: Verification }>(
        '/api/aws/verify',
        {
          ...credentials,
          region: assessment.instance.region,
          instanceId: assessment.instance.id,
          originalPublicIp: assessment.instance.publicIp,
        },
      );
      setVerification(result.verification);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? `恢复已完成，但验证失败：${requestError.message}`
          : '恢复已完成，但验证请求失败。',
      );
    }
    setFinalMethod(method);
    setActiveStrategy('done');
    setStage(4);
  }

  // This effect intentionally coordinates the active AWS run with the next recovery strategy.
  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    if (!run || !assessment) return;
    const status = run.kind === 'command' ? command?.status : execution?.status;
    if (!status) return;
    const terminal =
      run.kind === 'command'
        ? commandTerminal.has(status)
        : automationTerminal.has(status);
    if (!terminal) return;
    const handledKey = `${run.kind}:${run.id}:${status}`;
    if (handledRun.current === handledKey) return;
    handledRun.current = handledKey;
    const success =
      run.kind === 'command' ? status === 'Success' : automationSuccess.has(status);
    const executionMessage =
      run.kind === 'command'
        ? command?.stderr || command?.stdout || command?.statusDetails || status
        : execution?.statusMessage || status;

    if (success) {
      if (run.strategy === 'online-troubleshoot' && assessment.instance.platform === 'Linux') {
        setAttempts((value) => [
          ...value,
          {
            strategy: 'AWS 官方在线排障',
            status: 'success',
            message: '在线 SSH 配置修复完成，正在重新注入永久公钥。',
            id: run.id,
          },
        ]);
        setRun(null);
        void startOnline();
        return;
      }
      const method =
        run.strategy === 'ssm-online'
          ? 'SSM Run Command 不停机恢复'
          : run.strategy === 'online-troubleshoot'
            ? 'AWS 官方在线 Troubleshoot'
            : 'AWSSupport-ResetAccess 离线恢复';
      setAttempts((value) => [
        ...value,
        { strategy: method, status: 'success', message: '执行成功。', id: run.id },
      ]);
      void verifyAndFinish(method);
      return;
    }

    setAttempts((value) => [
      ...value,
      {
        strategy:
          run.strategy === 'ssm-online'
            ? 'SSM 不停机恢复'
            : run.strategy === 'online-troubleshoot'
              ? 'AWS 官方在线排障'
              : 'AWSSupport-ResetAccess',
        status: 'failed',
        message: executionMessage,
        id: run.id,
      },
    ]);
    setRun(null);
    if (run.strategy === 'ssm-online') {
      const retriedAfterTroubleshoot = attempts.some(
        (attempt) =>
          attempt.strategy === 'AWS 官方在线排障' && attempt.status === 'success',
      );
      setActiveStrategy(
        retriedAfterTroubleshoot
          ? 'offline'
          : assessment.strategies.instanceConnect.available
            ? 'eic'
            : 'existing',
      );
    } else if (run.strategy === 'online-troubleshoot') {
      setActiveStrategy('offline');
    } else {
      setActiveStrategy('offline');
    }
  }, [assessment, command, execution, run]);
  // oxlint-enable react-hooks/exhaustive-deps

  function clearSession() {
    setCredentials({ accessKeyId: '', secretAccessKey: '' });
    setAccount(null);
    setRegions([]);
    setInstances([]);
    setSelectedInstance(null);
    setAssessment(null);
    setSshPublicKey('');
    setRun(null);
    setCommand(null);
    setExecution(null);
    setAttempts([]);
    setTemporaryAccess(null);
    setVerification(null);
    setOfflineConfirmed(false);
    setError('');
    setStage(1);
  }

  const progressSteps = execution
    ? [...execution.steps, ...execution.children.flatMap((child) => child.steps)]
    : [];
  const finishedSteps = progressSteps.filter((step) =>
    ['Success', 'Failed', 'TimedOut', 'Skipped'].includes(step.status),
  ).length;
  const progressValue = execution
    ? progressSteps.length
      ? Math.round((finishedSteps / progressSteps.length) * 100)
      : 3
    : command
      ? command.status === 'Success'
        ? 100
        : commandTerminal.has(command.status)
          ? 100
          : 55
      : 5;

  const permanentKeyCommand = sshPublicKey
    ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF '${sshPublicKey.replaceAll("'", "'\\''")}' ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' '${sshPublicKey.replaceAll("'", "'\\''")}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
    : '';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#111922] text-white">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[#ffb547] text-[#1a1f25]">
              <CloudCog className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-wide">CloudRescue</p>
              <p className="text-[11px] text-slate-400">EC2 智能登录恢复</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {account ? (
              <span className="hidden font-mono text-xs text-slate-400 sm:block">
                {account.id}
              </span>
            ) : null}
            <Badge className="border-white/10 bg-white/8 text-slate-200" variant="outline">
              <LockKeyhole /> 凭证仅用于当前会话
            </Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1480px] grid-cols-1 lg:grid-cols-[265px_minmax(0,1fr)]">
        <aside className="border-b bg-[#16212d] px-5 py-5 text-slate-300 lg:min-h-[calc(100vh-64px)] lg:border-b-0 lg:border-r lg:border-white/6 lg:px-6 lg:py-8">
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            智能恢复流程
          </p>
          <ol className="grid gap-2 sm:grid-cols-4 lg:grid-cols-1">
            {stages.map((item) => (
              <li
                className={`flex items-center gap-3 rounded-xl px-3 py-3.5 ${item.id === stage ? 'bg-white/8 text-white' : item.id < stage ? 'text-slate-300' : 'text-slate-500'}`}
                key={item.id}
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-lg text-xs font-semibold ${item.id === stage ? 'bg-[#ffb547] text-[#18212b]' : item.id < stage ? 'bg-emerald-500/15 text-emerald-400' : 'border border-white/10 bg-white/3'}`}
                >
                  {item.id < stage ? <Check className="size-3.5" /> : item.id}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                    {item.detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-8 hidden rounded-xl border border-white/8 bg-black/10 p-4 lg:block">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
              <ShieldCheck className="size-4 text-emerald-400" /> 执行原则
            </div>
            <p className="text-xs leading-5 text-slate-500">
              SSM → Instance Connect → 其他登录方式 → 在线排障 → 用户确认后离线救援。
            </p>
          </div>
        </aside>

        <section className="min-w-0 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
          <div className="mx-auto max-w-6xl">
            {error ? (
              <Alert className="mb-5 border-red-200 bg-red-50" variant="destructive">
                <AlertTriangle />
                <AlertTitle>操作提示</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {stage === 1 ? (
              <>
                <PageHeading
                  eyebrow="第 1 步，共 4 步"
                  title="连接客户 AWS 账号"
                  description="使用专用 AK/SK 验证账号并扫描所有已启用区域。凭证不会写入数据库、日志或浏览器存储。"
                />
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
                  <div className="space-y-5">
                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader className="border-b border-border/70 pb-4">
                        <IconTitle
                          icon={<TerminalSquare />}
                          title="在客户 CloudShell 执行授权命令"
                          description="创建专用 IAM 用户，以及在线和离线恢复所需权限。"
                          tone="amber"
                        />
                      </CardHeader>
                      <CardContent className="pt-5">
                        <CodeBox
                          copied={copied === 'setup'}
                          onCopy={() => void copyText('setup', cloudShellCommand)}
                          value={cloudShellCommand}
                        />
                        <p className="mt-3 text-xs leading-5 text-muted-foreground">
                          任务结束后，应在 IAM 中禁用或删除 CloudRescueOperator 的 Access Key。
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader>
                        <IconTitle
                          icon={<KeyRound />}
                          title="输入专用访问凭证"
                          description="本步骤只验证身份和读取资源，不修改 EC2。"
                          tone="blue"
                        />
                      </CardHeader>
                      <CardContent>
                        <form className="space-y-4" onSubmit={scanAccount}>
                          <label className="block" htmlFor="aws-access-key-id">
                            <span className="mb-1.5 block text-xs font-medium text-slate-700">
                              AWS Access Key ID
                            </span>
                            <Input
                              id="aws-access-key-id"
                              autoComplete="off"
                              className="h-10 font-mono text-sm"
                              onChange={(event) =>
                                setCredentials((value) => ({
                                  ...value,
                                  accessKeyId: event.target.value.trim(),
                                }))
                              }
                              placeholder="AKIA••••••••••••••••"
                              spellCheck={false}
                              value={credentials.accessKeyId}
                            />
                          </label>
                          <label className="block" htmlFor="aws-secret-access-key">
                            <span className="mb-1.5 block text-xs font-medium text-slate-700">
                              AWS Secret Access Key
                            </span>
                            <div className="relative">
                              <Input
                                id="aws-secret-access-key"
                                autoComplete="new-password"
                                className="h-10 pr-20 font-mono text-sm"
                                onChange={(event) =>
                                  setCredentials((value) => ({
                                    ...value,
                                    secretAccessKey: event.target.value.trim(),
                                  }))
                                }
                                placeholder="••••••••••••••••••••••••••••••••"
                                spellCheck={false}
                                type={showSecret ? 'text' : 'password'}
                                value={credentials.secretAccessKey}
                              />
                              <button
                                aria-label={showSecret ? '隐藏 Secret Access Key' : '显示 Secret Access Key'}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                                onClick={() => setShowSecret((value) => !value)}
                                type="button"
                              >
                                {showSecret ? '隐藏' : '显示'}
                              </button>
                            </div>
                          </label>
                          <Button
                            className="h-10 w-full bg-[#d97808] text-white hover:bg-[#bc6300]"
                            disabled={
                              loading ||
                              !credentials.accessKeyId ||
                              !credentials.secretAccessKey
                            }
                            type="submit"
                          >
                            {loading ? <Spinner /> : <Radar />}
                            {loading ? '正在验证并扫描…' : '连接并扫描 EC2'}
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  </div>
                  <PrincipleCard />
                </div>
              </>
            ) : null}

            {stage === 2 ? (
              <>
                <PageHeading
                  action={
                    <Button onClick={clearSession} size="sm" variant="outline">
                      <Trash2 /> 断开连接
                    </Button>
                  }
                  eyebrow={`AWS Account ${account?.id || ''}`}
                  title="选择并诊断目标 EC2"
                  description={`已扫描 ${regions.length} 个启用区域，找到 ${instances.length} 台未终止实例。`}
                />

                <Card className="mb-5 border-0 shadow-sm ring-1 ring-slate-900/8">
                  <CardContent className="grid gap-3 pt-5 sm:grid-cols-[220px_minmax(0,1fr)_auto]">
                    <NativeSelect
                      aria-label="直接输入区域"
                      className="[&_select]:h-10"
                      onChange={(event) => setDirectRegion(event.target.value)}
                      value={directRegion}
                    >
                      {regions.map((region) => (
                        <NativeSelectOption key={region} value={region}>
                          {region}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Input
                      className="h-10 font-mono"
                      onChange={(event) => setDirectInstanceId(event.target.value.trim())}
                      placeholder="直接输入 EC2 Instance ID，例如 i-0123456789abcdef0"
                      value={directInstanceId}
                    />
                    <Button
                      className="h-10"
                      disabled={!directRegion || !directInstanceId || assessmentLoading}
                      onClick={() => void loadAssessment(directRegion, directInstanceId)}
                      variant="outline"
                    >
                      {assessmentLoading ? <Spinner /> : <Radar />} 智能检查
                    </Button>
                  </CardContent>
                </Card>

                <div className="mb-5 flex flex-col gap-3 sm:flex-row">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-10 pl-9"
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索名称、实例 ID 或 IP"
                      value={search}
                    />
                  </div>
                  <NativeSelect
                    aria-label="区域筛选"
                    className="w-full sm:w-56 [&_select]:h-10"
                    onChange={(event) => setRegionFilter(event.target.value)}
                    value={regionFilter}
                  >
                    <NativeSelectOption value="all">全部区域</NativeSelectOption>
                    {Array.from(new Set(instances.map((instance) => instance.region))).map(
                      (region) => (
                        <NativeSelectOption key={region} value={region}>
                          {region}
                        </NativeSelectOption>
                      ),
                    )}
                  </NativeSelect>
                </div>
                {scanWarnings.length ? (
                  <p className="mb-4 text-xs text-amber-700">
                    有 {scanWarnings.length} 个区域因权限或网络原因未完成扫描。
                  </p>
                ) : null}

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(380px,.85fr)]">
                  <div className="max-h-[680px] space-y-3 overflow-y-auto pr-1">
                    {filteredInstances.map((instance) => (
                      <button
                        aria-label={`选择并诊断实例 ${instance.name || instance.id}`}
                        className={`w-full rounded-xl bg-card p-4 text-left shadow-sm ring-1 transition hover:-translate-y-0.5 hover:shadow-md ${selectedInstance?.id === instance.id && selectedInstance.region === instance.region ? 'ring-2 ring-[#d97808]' : 'ring-slate-900/8'}`}
                        key={`${instance.region}:${instance.id}`}
                        onClick={() =>
                          void loadAssessment(instance.region, instance.id, instance)
                        }
                        type="button"
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={`grid size-10 shrink-0 place-items-center rounded-xl ${instance.platform === 'Windows' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}
                          >
                            <Server className="size-4.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="truncate text-sm font-semibold">
                                  {instance.name || '未命名实例'}
                                </p>
                                <p className="mt-1 font-mono text-xs text-muted-foreground">
                                  {instance.id}
                                </p>
                              </div>
                              <div className="flex gap-1.5">
                                <Badge variant="secondary">{instance.platform}</Badge>
                                <Badge
                                  className={
                                    instance.state === 'running'
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : 'bg-slate-100 text-slate-600'
                                  }
                                  variant="secondary"
                                >
                                  {instance.state}
                                </Badge>
                              </div>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                              <span>{instance.region}</span>
                              <span>{instance.availabilityZone}</span>
                              <span>{instance.architecture || instance.type}</span>
                              <span className="truncate font-mono">
                                {instance.publicIp || instance.privateIp || '无 IP'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="xl:sticky xl:top-5 xl:self-start">
                    <AssessmentCard
                      assessment={assessment}
                      loading={assessmentLoading}
                      onBegin={beginRecovery}
                      onKeyChange={setSshPublicKey}
                      sshPublicKey={sshPublicKey}
                    />
                  </div>
                </div>
              </>
            ) : null}

            {stage === 3 && assessment ? (
              <>
                <PageHeading
                  action={
                    !run ? (
                      <Button onClick={() => setStage(2)} size="sm" variant="outline">
                        <ChevronLeft /> 返回诊断
                      </Button>
                    ) : undefined
                  }
                  eyebrow={`${assessment.instance.region} · ${assessment.instance.id}`}
                  title="智能恢复决策与执行"
                  description="平台从不停机方案开始；当前方案不可用或失败后，自动进入下一层。"
                />

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(330px,.8fr)]">
                  <div className="space-y-5">
                    <StrategyTimeline
                      active={activeStrategy}
                      assessment={assessment}
                      attempts={attempts}
                    />

                    {run ? (
                      <ExecutionCard
                        command={command}
                        execution={execution}
                        lastUpdated={lastUpdated}
                        onRefresh={() => void refreshRun()}
                        progress={progressValue}
                        run={run}
                      />
                    ) : null}

                    {!run && activeStrategy === 'ssm' ? (
                      <ActionCard
                        badge="方案 1 · 推荐"
                        description={
                          assessment.instance.platform === 'Linux'
                            ? '自动识别常见登录用户，备份 authorized_keys，追加新公钥并修复权限与所有者。'
                            : '检查 Administrator、RDP 服务、远程连接设置、Windows Firewall 与 EC2Launch。'
                        }
                        icon={<Wifi />}
                        title="SSM 不停机在线恢复"
                        tone="green"
                      >
                        <Button
                          className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
                          disabled={loading}
                          onClick={() => void startOnline()}
                        >
                          {loading ? <Spinner /> : <ShieldCheck />}
                          {loading ? '正在发送命令…' : '立即执行在线恢复'}
                        </Button>
                      </ActionCard>
                    ) : null}

                    {!run && activeStrategy === 'eic' ? (
                      <ActionCard
                        badge="方案 2 · Linux"
                        description={assessment.strategies.instanceConnect.reason}
                        icon={<Network />}
                        title="EC2 Instance Connect 临时接入"
                        tone="blue"
                      >
                        <div className="space-y-4">
                          <label className="block" htmlFor="instance-os-user">
                            <span className="mb-1.5 block text-xs font-medium text-slate-700">
                              Instance OS User
                            </span>
                            <NativeSelect
                              id="instance-os-user"
                              className="[&_select]:h-10"
                              onChange={(event) => setOsUser(event.target.value)}
                              value={osUser}
                            >
                              {['ec2-user', 'ubuntu', 'centos', 'rocky', 'almalinux', 'admin', 'root'].map(
                                (user) => (
                                  <NativeSelectOption key={user} value={user}>
                                    {user}
                                  </NativeSelectOption>
                                ),
                              )}
                            </NativeSelect>
                          </label>
                          {!temporaryAccess ? (
                            <Button
                              className="w-full"
                              disabled={loading}
                              onClick={() => void pushInstanceConnectKey()}
                            >
                              {loading ? <Spinner /> : <KeyRound />}
                              {loading ? '正在推送…' : '发送 60 秒临时公钥'}
                            </Button>
                          ) : (
                            <div className="space-y-3">
                              <Alert className="border-blue-200 bg-blue-50">
                                <CheckCircle2 />
                                <AlertTitle>临时公钥已发送 · 剩余 {remainingSeconds} 秒</AlertTitle>
                                <AlertDescription>
                                  AWS API 只提供临时认证。请立即使用匹配的私钥登录，然后执行下方命令把公钥永久写入。
                                </AlertDescription>
                              </Alert>
                              <CodeBox
                                copied={copied === 'persist-key'}
                                onCopy={() =>
                                  void copyText('persist-key', permanentKeyCommand)
                                }
                                value={permanentKeyCommand}
                              />
                              <div className="grid gap-2 sm:grid-cols-2">
                                <Button
                                  onClick={() => {
                                    setFinalMethod('EC2 Instance Connect + 在线永久写入');
                                    setActiveStrategy('done');
                                    void verifyAndFinish(
                                      'EC2 Instance Connect + 在线永久写入',
                                    );
                                  }}
                                >
                                  <CheckCircle2 /> 已登录并永久写入
                                </Button>
                                <Button
                                  onClick={() => {
                                    setTemporaryAccess(null);
                                    setActiveStrategy('existing');
                                  }}
                                  variant="outline"
                                >
                                  临时连接失败，继续
                                </Button>
                              </div>
                            </div>
                          )}
                          <p className="text-xs leading-5 text-muted-foreground">
                            托管 Sites 不支持原始 TCP/SSH，因此平台不能代替客户终端建立 SSH
                            会话；这里不会把 60 秒临时授权误报为永久恢复。
                          </p>
                        </div>
                      </ActionCard>
                    ) : null}

                    {!run && activeStrategy === 'existing' ? (
                      <ActionCard
                        badge="方案 3 · 人工确认"
                        description="AWS API 无法知道客户是否还保留旧私钥、其他管理员账号、堡垒机或 RDP 凭证。"
                        icon={<Laptop />}
                        title="检查其他已有登录方式"
                        tone="slate"
                      >
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button
                            onClick={() =>
                              void verifyAndFinish('使用已有 SSH / RDP / Bastion 在线恢复')
                            }
                            variant="outline"
                          >
                            <CheckCircle2 /> 已通过其他方式恢复
                          </Button>
                          <Button
                            onClick={() => {
                              setAttempts((value) => [
                                ...value,
                                {
                                  strategy: '其他已有登录方式',
                                  status: 'skipped',
                                  message: '客户确认没有可用的 SSH、RDP 或 Bastion 登录方式。',
                                },
                              ]);
                              setActiveStrategy(
                                assessment.strategies.troubleshoot.available
                                  ? 'troubleshoot'
                                  : 'offline',
                              );
                            }}
                          >
                            没有可用方式，继续 <ChevronRight />
                          </Button>
                        </div>
                      </ActionCard>
                    ) : null}

                    {!run && activeStrategy === 'troubleshoot' ? (
                      <ActionCard
                        badge="方案 4 · 在线"
                        description={assessment.strategies.troubleshoot.reason}
                        icon={<CloudCog />}
                        title={`运行 ${assessment.strategies.troubleshoot.document}`}
                        tone="amber"
                      >
                        <Alert className="mb-4 border-amber-200 bg-amber-50">
                          <ShieldCheck />
                          <AlertTitle>强制在线模式</AlertTitle>
                          <AlertDescription>
                            参数 AllowOffline=false，不允许该 Runbook 停止实例或拆系统盘。
                          </AlertDescription>
                        </Alert>
                        <Button
                          className="w-full bg-[#d97808] text-white hover:bg-[#bc6300]"
                          disabled={loading}
                          onClick={() => void startTroubleshoot()}
                        >
                          {loading ? <Spinner /> : <CloudCog />}
                          {loading ? '正在启动…' : '开始官方在线排障'}
                        </Button>
                      </ActionCard>
                    ) : null}

                    {!run && activeStrategy === 'offline' ? (
                      <ActionCard
                        badge="方案 5 · 最后兜底"
                        description="在线恢复方式均不可用或已经失败。下一步会停止 EC2，并使用 EC2Rescue 修复系统盘。"
                        icon={<AlertTriangle />}
                        title="AWSSupport-ResetAccess 离线恢复"
                        tone="red"
                      >
                        <div className="space-y-3">
                          {assessment.strategies.offline.warnings.map((warning) => (
                            <div
                              className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"
                              key={warning}
                            >
                              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                              {warning}
                            </div>
                          ))}
                          <div className="flex items-start gap-3 rounded-xl border bg-muted/35 p-4">
                            <Checkbox
                              id="offline-confirmation"
                              checked={offlineConfirmed}
                              onCheckedChange={(value) =>
                                setOfflineConfirmed(Boolean(value))
                              }
                            />
                            <label className="cursor-pointer text-xs leading-5 text-slate-700" htmlFor="offline-confirmation">
                              我确认在线方式均不可用，并同意停止实例、创建备份、挂载根盘及创建临时救援资源。
                            </label>
                          </div>
                          <Button
                            className="w-full bg-red-600 text-white hover:bg-red-700"
                            disabled={
                              !offlineConfirmed ||
                              !assessment.strategies.offline.available ||
                              loading
                            }
                            onClick={() => void startOffline()}
                          >
                            {loading ? <Spinner /> : <AlertTriangle />}
                            {loading ? '正在启动离线自动化…' : '确认停机并执行最终救援'}
                          </Button>
                          {!assessment.strategies.offline.available ? (
                            <p className="text-xs text-red-700">
                              当前实例不符合官方 ResetAccess 的基础条件，不能自动执行。
                            </p>
                          ) : null}
                        </div>
                      </ActionCard>
                    ) : null}
                  </div>

                  <div className="space-y-5 xl:sticky xl:top-5 xl:self-start">
                    <CompactAssessment assessment={assessment} />
                    <AttemptHistory attempts={attempts} />
                  </div>
                </div>
              </>
            ) : null}

            {stage === 4 && assessment ? (
              <>
                <PageHeading
                  action={
                    <Button onClick={clearSession} size="sm" variant="outline">
                      恢复另一台实例
                    </Button>
                  }
                  eyebrow="恢复结果"
                  title="EC2 登录恢复流程已完成"
                  description="以下结果来自执行输出和恢复后的 AWS 状态复查。"
                />
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                    <CardHeader className="border-b border-border/70">
                      <div className="flex items-start gap-3">
                        <span className="grid size-11 place-items-center rounded-full bg-emerald-50 text-emerald-700">
                          <CheckCircle2 className="size-6" />
                        </span>
                        <div>
                          <CardTitle>恢复完成</CardTitle>
                          <CardDescription className="mt-1">{finalMethod}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5 pt-5">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <InfoItem label="Instance ID" mono value={assessment.instance.id} />
                        <InfoItem label="恢复方案" value={finalMethod} />
                        <InfoItem
                          label="EC2 状态"
                          value={verification?.state || '验证中/未取得'}
                        />
                        <InfoItem
                          label="SSM PingStatus"
                          value={verification?.ssmPingStatus || '未取得'}
                        />
                        <InfoItem
                          label="当前 Public IP"
                          mono
                          value={verification?.publicIp || assessment.instance.publicIp || '无'}
                        />
                        <InfoItem
                          label="Public IP 变化"
                          value={verification?.publicIpChanged ? '已变化' : '未发现变化'}
                        />
                        {execution?.result.linuxBackupAmi ||
                        execution?.result.windowsBackupAmi ? (
                          <InfoItem
                            label="Backup AMI ID"
                            mono
                            value={
                              execution.result.linuxBackupAmi ||
                              execution.result.windowsBackupAmi
                            }
                          />
                        ) : null}
                        {run?.kind === 'automation' ? (
                          <InfoItem label="AutomationExecutionId" mono value={run.id} />
                        ) : null}
                      </div>

                      {execution?.result.linuxKeyParameter ? (
                        <Alert className="border-blue-200 bg-blue-50">
                          <FileKey2 />
                          <AlertTitle>新的 Linux SSH 私钥保存在 Parameter Store</AlertTitle>
                          <AlertDescription>
                            <span className="mt-2 block break-all font-mono text-xs">
                              {execution.result.linuxKeyParameter}
                            </span>
                            <span className="mt-2 block">
                              平台只展示 Parameter Name，不读取、不返回、不记录私钥内容。
                            </span>
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {execution?.result.windowsPasswordEnabledAmi ? (
                        <Alert className="border-amber-200 bg-amber-50">
                          <AlertTriangle />
                          <AlertTitle>Windows Password Enabled AMI 已生成</AlertTitle>
                          <AlertDescription>
                            <span className="mt-2 block font-mono text-xs">
                              {execution.result.windowsPasswordEnabledAmi}
                            </span>
                            <span className="mt-2 block">
                              原 Key Pair 无法找回。请使用新 Key Pair 从该 AMI
                              启动新实例；平台不会自动替换原生产实例。
                            </span>
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {verification ? (
                        <div className="grid gap-3 rounded-xl border bg-slate-50/70 p-4 sm:grid-cols-3">
                          <CheckItem
                            label="System Status"
                            ok={verification.statusChecks.system === 'ok'}
                            value={verification.statusChecks.system}
                          />
                          <CheckItem
                            label="Instance Status"
                            ok={verification.statusChecks.instance === 'ok'}
                            value={verification.statusChecks.instance}
                          />
                          <CheckItem
                            label={`${verification.remotePort}/TCP 安全组`}
                            ok={verification.remotePortSecurityGroupRule}
                            value={
                              verification.remotePortSecurityGroupRule
                                ? '存在入站规则'
                                : '未发现入站规则'
                            }
                          />
                          <p className="col-span-full text-[11px] leading-5 text-muted-foreground">
                            {verification.note}
                          </p>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                  <AttemptHistory attempts={attempts} />
                </div>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function AssessmentCard({
  assessment,
  loading,
  onBegin,
  onKeyChange,
  sshPublicKey,
}: {
  assessment: Assessment | null;
  loading: boolean;
  onBegin: () => void;
  onKeyChange: (value: string) => void;
  sshPublicKey: string;
}) {
  return (
    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
      <CardHeader>
        <CardTitle>智能诊断</CardTitle>
        <CardDescription>读取基础配置，判断最优恢复路径。</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner /> 正在检查 SSM、网络、根盘和状态检查…
          </div>
        ) : assessment ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <InfoItem label="系统" value={assessment.instance.platform} />
              <InfoItem label="架构" value={assessment.instance.architecture || '未知'} />
              <InfoItem label="实例状态" value={assessment.instance.state} />
              <InfoItem label="SSM" value={assessment.ssm.pingStatus} />
              <InfoItem label="System Check" value={assessment.statusChecks.system} />
              <InfoItem label="Instance Check" value={assessment.statusChecks.instance} />
              <InfoItem
                label="根 EBS"
                mono
                value={assessment.instance.rootVolumeId || '不适用'}
              />
              <InfoItem
                label="加密"
                value={assessment.instance.rootVolumeEncrypted ? '已加密' : '未加密'}
              />
            </div>
            <div className="rounded-xl border p-3">
              <p className="mb-2 text-xs font-semibold text-slate-700">建议方案</p>
              <div className="space-y-2 text-xs">
                <DecisionLine
                  active={assessment.strategies.ssm.available}
                  label="SSM 不停机恢复"
                  reason={assessment.strategies.ssm.reason}
                />
                <DecisionLine
                  active={assessment.strategies.instanceConnect.available}
                  label="EC2 Instance Connect"
                  reason={assessment.strategies.instanceConnect.reason}
                />
                <DecisionLine
                  active={assessment.strategies.troubleshoot.available}
                  label="AWS 在线 Troubleshoot"
                  reason={assessment.strategies.troubleshoot.reason}
                />
              </div>
            </div>
            <Accordion>
              <AccordionItem value="instance-details">
                <AccordionTrigger className="text-xs">基础信息详情</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-2">
                    <InfoItem label="Availability Zone" value={assessment.instance.availabilityZone} />
                    <InfoItem label="Instance Type" value={assessment.instance.instanceType} />
                    <InfoItem label="VPC" mono value={assessment.instance.vpcId} />
                    <InfoItem label="Subnet" mono value={assessment.instance.subnetId} />
                    <InfoItem label="Public IP" mono value={assessment.instance.publicIp || '无'} />
                    <InfoItem label="Elastic IP" mono value={assessment.instance.elasticIp || '无'} />
                    <InfoItem label="IAM Profile" mono value={assessment.instance.iamInstanceProfile || '无'} />
                    <InfoItem label="KMS Key" mono value={assessment.instance.kmsKeyId || '无'} />
                    <InfoItem label="Auto Scaling" value={assessment.instance.autoScalingGroupName || '否'} />
                    <InfoItem label="Instance Store 风险" value={assessment.instance.hasInstanceStore ? '有' : '未发现'} />
                    <InfoItem
                      label="Security Groups"
                      mono
                      value={assessment.instance.securityGroups.map((group) => group.id).join(', ') || '无'}
                    />
                    <InfoItem
                      label="Instance Connect Endpoint"
                      mono
                      value={assessment.network.instanceConnectEndpointId || '无'}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            {assessment.instance.platform === 'Linux' ? (
              <label className="block" htmlFor="new-ssh-public-key">
                <span className="mb-1.5 block text-xs font-medium text-slate-700">
                  新 SSH 公钥
                </span>
                <Textarea
                  id="new-ssh-public-key"
                  className="min-h-24 font-mono text-xs"
                  onChange={(event) => onKeyChange(event.target.value)}
                  placeholder="ssh-ed25519 AAAAC3... user@example"
                  spellCheck={false}
                  value={sshPublicKey}
                />
                <span className="mt-1.5 block text-[11px] leading-5 text-muted-foreground">
                  只接受公钥。请勿输入私钥、PEM 文件或旧密码。
                </span>
              </label>
            ) : null}
            <Button
              className="h-10 w-full bg-[#d97808] text-white hover:bg-[#bc6300]"
              disabled={
                assessment.instance.state !== 'running' ||
                (assessment.instance.platform === 'Linux' && !sshPublicKey.trim())
              }
              onClick={onBegin}
            >
              进入智能恢复 <ChevronRight />
            </Button>
            {assessment.instance.state !== 'running' ? (
              <p className="text-xs text-amber-700">
                当前第一版仅对 Running 实例执行在线恢复；请先启动实例后重新检查。
              </p>
            ) : null}
          </div>
        ) : (
          <p className="py-12 text-sm leading-6 text-muted-foreground">
            从左侧选择实例，或直接输入 Region 与 Instance ID。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CompactAssessment({ assessment }: { assessment: Assessment }) {
  return (
    <Card className="border-0 shadow-sm ring-1 ring-slate-900/8">
      <CardHeader>
        <CardTitle className="text-sm">目标实例</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-semibold">
            {assessment.instance.name || assessment.instance.id}
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {assessment.instance.id}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <InfoItem label="系统" value={assessment.instance.platform} />
          <InfoItem label="架构" value={assessment.instance.architecture} />
          <InfoItem label="SSM" value={assessment.ssm.pingStatus} />
          <InfoItem
            label="远程端口"
            value={`${assessment.network.port}/TCP ${assessment.network.portRulePresent ? '有规则' : '无规则'}`}
          />
          <InfoItem label="VPC" mono value={assessment.instance.vpcId} />
          <InfoItem label="Subnet" mono value={assessment.instance.subnetId} />
        </div>
        {assessment.strategies.offline.warnings.length ? (
          <Accordion>
            <AccordionItem value="warnings">
              <AccordionTrigger className="text-xs text-amber-800">
                离线风险 {assessment.strategies.offline.warnings.length} 项
              </AccordionTrigger>
              <AccordionContent className="space-y-2">
                {assessment.strategies.offline.warnings.map((warning) => (
                  <p className="text-xs leading-5 text-muted-foreground" key={warning}>
                    {warning}
                  </p>
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StrategyTimeline({
  active,
  assessment,
  attempts,
}: {
  active: Strategy;
  assessment: Assessment;
  attempts: Attempt[];
}) {
  const items: { key: Strategy; title: string; subtitle: string; available: boolean }[] = [
    {
      key: 'ssm',
      title: 'SSM 在线恢复',
      subtitle: '不停机写入凭证并修复服务',
      available: assessment.strategies.ssm.available,
    },
    {
      key: 'eic',
      title: 'Instance Connect',
      subtitle: 'Linux 60 秒临时公钥',
      available: assessment.strategies.instanceConnect.available,
    },
    {
      key: 'existing',
      title: '已有登录方式',
      subtitle: 'SSH / RDP / Bastion',
      available: true,
    },
    {
      key: 'troubleshoot',
      title: '在线 Troubleshoot',
      subtitle: assessment.strategies.troubleshoot.document,
      available: assessment.strategies.troubleshoot.available,
    },
    {
      key: 'offline',
      title: '离线 ResetAccess',
      subtitle: '停机、备份和 EC2Rescue',
      available: assessment.strategies.offline.available,
    },
  ];
  return (
    <Card className="border-0 shadow-sm ring-1 ring-slate-900/8">
      <CardContent className="pt-5">
        <div className="grid gap-2 md:grid-cols-5">
          {items.map((item, index) => {
            const isActive = active === item.key;
            const tried = attempts.some((attempt) =>
              attempt.strategy.toLowerCase().includes(
                item.key === 'ssm'
                  ? 'ssm'
                  : item.key === 'eic'
                    ? 'instance connect'
                    : item.key === 'existing'
                      ? '其他'
                      : item.key === 'troubleshoot'
                        ? '排障'
                        : 'resetaccess',
              ),
            );
            return (
              <div className="relative" key={item.key}>
                <div
                  className={`h-full rounded-xl border p-3 ${isActive ? 'border-[#d97808] bg-amber-50/60' : tried ? 'border-emerald-200 bg-emerald-50/50' : !item.available ? 'bg-slate-50 opacity-55' : 'bg-white'}`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span
                      className={`grid size-6 place-items-center rounded-full text-[11px] font-bold ${isActive ? 'bg-[#d97808] text-white' : tried ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}
                    >
                      {tried ? <Check className="size-3.5" /> : index + 1}
                    </span>
                    {!item.available ? (
                      <Badge className="text-[9px]" variant="secondary">
                        不可用
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs font-semibold text-slate-800">{item.title}</p>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                    {item.subtitle}
                  </p>
                </div>
                {index < items.length - 1 ? (
                  <ArrowDown className="mx-auto mt-1 size-3 text-slate-300 md:hidden" />
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ExecutionCard({
  command,
  execution,
  lastUpdated,
  onRefresh,
  progress,
  run,
}: {
  command: CommandExecution | null;
  execution: AutomationExecution | null;
  lastUpdated: Date | null;
  onRefresh: () => void;
  progress: number;
  run: Run;
}) {
  const commandSteps: ExecutionStep[] = [
    {
      id: 'check',
      name: 'check',
      label: '确认 SSM 在线',
      action: 'DescribeInstanceInformation',
      status: 'Success',
      detail: '实例已通过 SSM 基础检查。',
      startedAt: '',
      endedAt: '',
    },
    {
      id: 'dispatch',
      name: 'dispatch',
      label: '分发在线恢复命令',
      action: 'SendCommand',
      status: command ? 'Success' : 'InProgress',
      detail: '命令通过 AWS Systems Manager 下发。',
      startedAt: '',
      endedAt: '',
    },
    {
      id: 'execute',
      name: 'execute',
      label: '在实例内执行修复',
      action: 'Run Command',
      status: command?.status || 'Pending',
      detail: command?.statusDetails || '等待实例执行。',
      startedAt: command?.startedAt || '',
      endedAt: command?.endedAt || '',
    },
    {
      id: 'verify',
      name: 'verify',
      label: '验证命令结果',
      action: 'GetCommandInvocation',
      status:
        command?.status === 'Success'
          ? 'Success'
          : command && commandTerminal.has(command.status)
            ? 'Failed'
            : 'Pending',
      detail: command?.stderr || command?.stdout || '',
      startedAt: '',
      endedAt: '',
    },
  ];
  const status = run.kind === 'command' ? command?.status || 'Pending' : execution?.status || 'Pending';
  return (
    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
      <CardHeader className="border-b border-border/70 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>实时执行过程</CardTitle>
            <CardDescription className="mt-1 font-mono text-[11px]">
              {run.id}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={statusColor(status)} variant="secondary">
              {statusText(status)}
            </Badge>
            <Button onClick={onRefresh} size="sm" variant="outline">
              <RefreshCw
                className={
                  status === 'InProgress' || status === 'In Progress'
                    ? 'animate-spin'
                    : ''
                }
              />
              刷新
            </Button>
          </div>
        </div>
        <Progress className="mt-4" value={progress} />
        {lastUpdated ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            最近同步：{lastUpdated.toLocaleTimeString('zh-CN')}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {run.kind === 'command' ? (
          <div className="relative divide-y divide-border/70 before:absolute before:bottom-5 before:left-3 before:top-5 before:w-px before:bg-border">
            {commandSteps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </div>
        ) : !execution ? (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner /> 正在读取第一批 Automation Steps…
          </div>
        ) : (
          <div>
            {run.strategy === 'offline-reset' ? (
              <SimpleOfflineFlow execution={execution} />
            ) : (
              <div className="relative divide-y divide-border/70 before:absolute before:bottom-5 before:left-3 before:top-5 before:w-px before:bg-border">
                {execution.steps.map((step) => <StepRow key={step.id} step={step} />)}
              </div>
            )}
            {run.strategy === 'offline-reset' || execution.children.length ? (
              <Accordion className="mt-4">
                <AccordionItem value="outer-steps">
                  <AccordionTrigger>
                    高级详情 · {execution.documentName || run.documentName} · {statusText(execution.status)}
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="relative divide-y rounded-xl border bg-slate-50/70 px-3 before:absolute before:bottom-5 before:left-6 before:top-5 before:w-px before:bg-border">
                      {execution.steps.map((step) => (
                        <StepRow key={step.id} nested step={step} />
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
                {execution.children.map((child) => (
                  <AccordionItem key={child.executionId} value={child.executionId}>
                    <AccordionTrigger>
                      高级详情 · {child.documentName} · {statusText(child.status)}
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="relative divide-y rounded-xl border bg-slate-50/70 px-3 before:absolute before:bottom-5 before:left-6 before:top-5 before:w-px before:bg-border">
                        {child.steps.map((step) => (
                          <StepRow key={step.id} nested step={step} />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SimpleOfflineFlow({ execution }: { execution: AutomationExecution }) {
  const allSteps = [...execution.steps, ...execution.children.flatMap((child) => child.steps)];
  const phases = [
    { label: '检查实例', keywords: ['describeinstance', 'assertinstance', 'describeroot'] },
    { label: '创建备份', keywords: ['backupami', 'createpreec2rescuebackup'] },
    { label: '停止实例', keywords: ['stopinstance', 'forcestopinstance'] },
    { label: '创建救援环境', keywords: ['createec2rescue', 'waitforec2rescue'] },
    { label: '挂载系统盘', keywords: ['detachrootvolume', 'attachrootvolumetoec2rescue'] },
    { label: '执行修复', keywords: ['runscript', 'runec2rescue'] },
    { label: '恢复系统盘', keywords: ['detachrootvolumefrom', 'attachrootvolumeback'] },
    { label: '启动实例', keywords: ['restoresourceinstancestate'] },
    { label: '清理救援资源', keywords: ['deleteec2rescuestack'] },
    { label: '验证输出', keywords: ['getec2rescue', 'getlinuxsshkey', 'getwindowspassword'] },
    { label: '恢复完成', keywords: [] },
  ];
  function phaseStatus(keywords: string[], final = false) {
    if (final) {
      if (automationSuccess.has(execution.status)) return 'Success';
      if (automationTerminal.has(execution.status)) return 'Failed';
      return 'Pending';
    }
    const matches = allSteps.filter((step) =>
      keywords.some((keyword) => step.name.toLowerCase().includes(keyword)),
    );
    if (matches.some((step) => ['Failed', 'TimedOut'].includes(step.status))) return 'Failed';
    if (matches.some((step) => ['InProgress', 'Waiting'].includes(step.status))) return 'InProgress';
    if (matches.some((step) => step.status === 'Success')) return 'Success';
    return 'Pending';
  }
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
        客户可见进度
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {phases.map((phase, index) => {
          const status = phaseStatus(phase.keywords, index === phases.length - 1);
          return (
            <div className="flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5" key={phase.label}>
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-slate-50">
                <StepIcon status={status} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-slate-800">{phase.label}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{statusText(status)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionCard({
  badge,
  children,
  description,
  icon,
  title,
  tone,
}: {
  badge: string;
  children: React.ReactNode;
  description: string;
  icon: React.ReactNode;
  title: string;
  tone: 'green' | 'blue' | 'amber' | 'red' | 'slate';
}) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700',
    blue: 'bg-blue-50 text-blue-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    slate: 'bg-slate-100 text-slate-700',
  };
  return (
    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tones[tone]}`}>
            {icon}
          </span>
          <div>
            <Badge className="mb-2" variant="outline">
              {badge}
            </Badge>
            <CardTitle>{title}</CardTitle>
            <CardDescription className="mt-1.5 leading-5">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function AttemptHistory({ attempts }: { attempts: Attempt[] }) {
  return (
    <Card className="border-0 shadow-sm ring-1 ring-slate-900/8">
      <CardHeader>
        <CardTitle className="text-sm">恢复尝试记录</CardTitle>
        <CardDescription>每次降级都有原因，不会直接跳到停机方案。</CardDescription>
      </CardHeader>
      <CardContent>
        {attempts.length ? (
          <ol className="space-y-3">
            {attempts.map((attempt, index) => (
              <li className="flex gap-3" key={`${attempt.strategy}:${index}`}>
                <span
                  className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${attempt.status === 'success' ? 'bg-emerald-50 text-emerald-700' : attempt.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-500'}`}
                >
                  {attempt.status === 'success' ? (
                    <Check className="size-3.5" />
                  ) : attempt.status === 'failed' ? (
                    <XCircle className="size-3.5" />
                  ) : (
                    <SkipForward className="size-3.5" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800">{attempt.strategy}</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    {attempt.message}
                  </p>
                  {attempt.id ? (
                    <p className="mt-1 truncate font-mono text-[10px] text-slate-400">
                      {attempt.id}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="py-4 text-xs leading-5 text-muted-foreground">
            尚未执行恢复。系统会先尝试当前最优的不停机方案。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionLine({
  active,
  label,
  reason,
}: {
  active: boolean;
  label: string;
  reason: string;
}) {
  return (
    <div className="flex gap-2">
      {active ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-slate-400" />
      )}
      <div>
        <p className="font-medium text-slate-700">{label}</p>
        <p className="mt-0.5 leading-5 text-muted-foreground">{reason}</p>
      </div>
    </div>
  );
}

function CheckItem({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className={`mt-1 flex items-center gap-1.5 text-xs font-medium ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>
        {ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
        {value}
      </p>
    </div>
  );
}

function CodeBox({
  copied,
  onCopy,
  value,
}: {
  copied: boolean;
  onCopy: () => void;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-[#111922] px-4 py-3 text-slate-200 shadow-inner">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">
        <span className="mr-2 select-none text-[#ffb547]">$</span>
        {value}
      </code>
      <Button
        className="shrink-0 border-white/10 bg-white/8 text-white hover:bg-white/14"
        onClick={onCopy}
        size="sm"
        variant="outline"
      >
        {copied ? <Check /> : <Clipboard />} {copied ? '已复制' : '复制'}
      </Button>
    </div>
  );
}

function PageHeading({
  action,
  description,
  eyebrow,
  title,
}: {
  action?: React.ReactNode;
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#b35e00]">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function IconTitle({
  description,
  icon,
  title,
  tone,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
  tone: 'amber' | 'blue';
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone === 'amber' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}
      >
        {icon}
      </span>
      <div>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="mt-1">{description}</CardDescription>
      </div>
    </div>
  );
}

function InfoItem({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 truncate text-xs font-medium text-slate-700 ${mono ? 'font-mono' : ''}`}>
        {value || '—'}
      </p>
    </div>
  );
}

function PrincipleCard() {
  return (
    <Card className="border-0 bg-[#182531] text-white ring-0">
      <CardHeader>
        <CardTitle className="text-white">恢复策略</CardTitle>
        <CardDescription className="text-slate-400">
          停机和拆系统盘永远是最后的兜底。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4">
          {[
            ['01', 'SSM 在线恢复', '直接修复凭证与远程服务'],
            ['02', 'EC2 Instance Connect', 'Linux 临时登录窗口'],
            ['03', '其他已有方式', '旧 Key、管理员或 Bastion'],
            ['04', '在线 Troubleshoot', 'AWS 官方在线 Runbook'],
            ['05', '离线 ResetAccess', '用户确认后才允许停机'],
          ].map(([number, title, detail]) => (
            <li className="flex gap-3" key={number}>
              <span className="font-mono text-xs text-[#ffb547]">{number}</span>
              <div>
                <p className="text-sm font-medium text-slate-100">{title}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex gap-2 rounded-xl border border-white/8 bg-black/10 p-3 text-xs leading-5 text-slate-400">
          <WifiOff className="mt-0.5 size-4 shrink-0 text-[#ffb547]" />
          只有前面的在线路径全部不可用或失败，界面才会开放离线确认。
        </div>
      </CardContent>
    </Card>
  );
}
