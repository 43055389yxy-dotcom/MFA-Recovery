'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Clipboard,
  CloudCog,
  Download,
  Eye,
  EyeOff,
  FileKey2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MonitorCog,
  Radar,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SkipForward,
  TerminalSquare,
  Trash2,
  XCircle,
} from 'lucide-react';

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
  availabilityZone: string;
  publicIp: string;
  privateIp: string;
  keyName: string;
  rootDeviceType: string;
  launchTime: string;
};

type Preflight = {
  instanceId: string;
  region: string;
  availabilityZone: string;
  platform: 'Linux' | 'Windows';
  rootDeviceType: string;
  rootVolumeId: string;
  encrypted: boolean;
  kmsKeyId: string;
  hasElasticIp: boolean;
  autoScalingGroupName: string;
  isMarketplace: boolean;
  supported: boolean;
  warnings: string[];
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

type Execution = {
  id: string;
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
  };
};

const steps = [
  { id: 1, label: '授权连接', detail: '创建专用凭证' },
  { id: 2, label: '选择实例', detail: '扫描已启用区域' },
  { id: 3, label: '执行恢复', detail: '查看实时步骤' },
];

const terminalStatuses = new Set([
  'Success',
  'Failed',
  'TimedOut',
  'Cancelled',
  'Exited',
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

function StepIcon({ status }: { status: string }) {
  if (status === 'Success') return <CheckCircle2 className="size-4 text-emerald-600" />;
  if (status === 'Skipped') return <SkipForward className="size-4 text-slate-400" />;
  if (status === 'Failed' || status === 'TimedOut') return <XCircle className="size-4 text-red-600" />;
  if (status === 'InProgress' || status === 'Waiting') {
    return <LoaderCircle className="size-4 animate-spin text-[#d97808]" />;
  }
  return <Circle className="size-4 text-slate-300" />;
}

function statusText(status: string) {
  const values: Record<string, string> = {
    Pending: '等待中',
    InProgress: '进行中',
    Waiting: '等待中',
    Success: '已完成',
    Skipped: '已跳过',
    Failed: '失败',
    TimedOut: '超时',
    Cancelled: '已取消',
    Cancelling: '取消中',
  };
  return values[status] || status;
}

function StepRow({ step, nested = false }: { step: ExecutionStep; nested?: boolean }) {
  return (
    <div className={`relative flex gap-3 ${nested ? 'py-2.5' : 'py-3.5'}`}>
      <span className="relative z-10 mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-card">
        <StepIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`${nested ? 'text-xs' : 'text-sm'} font-medium text-slate-800`}>{step.label}</p>
          <Badge
            className={
              step.status === 'Success'
                ? 'bg-emerald-50 text-emerald-700'
                : step.status === 'InProgress' || step.status === 'Waiting'
                  ? 'bg-amber-50 text-amber-700'
                  : step.status === 'Failed' || step.status === 'TimedOut'
                    ? 'bg-red-50 text-red-700'
                    : 'bg-slate-100 text-slate-500'
            }
            variant="secondary"
          >
            {statusText(step.status)}
          </Badge>
        </div>
        {step.detail ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p> : null}
        {step.startedAt ? (
          <p className="mt-1 font-mono text-[10px] text-slate-400">
            {new Date(step.startedAt).toLocaleTimeString('zh-CN')}
            {step.endedAt ? ` — ${new Date(step.endedAt).toLocaleTimeString('zh-CN')}` : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function Home() {
  const [stage, setStage] = useState(1);
  const [credentials, setCredentials] = useState<Credentials>({ accessKeyId: '', secretAccessKey: '' });
  const [showSecret, setShowSecret] = useState(false);
  const [cloudShellCommand, setCloudShellCommand] = useState('curl -fsSL https://YOUR-SITE/setup.sh | bash');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [scanWarnings, setScanWarnings] = useState<{ region: string; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [executionId, setExecutionId] = useState('');
  const [execution, setExecution] = useState<Execution | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [privateKey, setPrivateKey] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);

  useEffect(() => {
    setCloudShellCommand(`curl -fsSL ${window.location.origin}/setup.sh | bash`);
  }, []);

  const copyText = useCallback(async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
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

  async function scanAccount(event: React.FormEvent) {
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
      setStage(2);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '账号连接失败。');
    } finally {
      setLoading(false);
    }
  }

  async function chooseInstance(instance: Instance) {
    setSelectedInstance(instance);
    setPreflight(null);
    setError('');
    setPreflightLoading(true);
    try {
      const result = await postJson<{ ok: true; preflight: Preflight }>('/api/aws/preflight', {
        ...credentials,
        region: instance.region,
        instanceId: instance.id,
      });
      setPreflight(result.preflight);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '实例检查失败。');
    } finally {
      setPreflightLoading(false);
    }
  }

  async function startRecovery() {
    if (!selectedInstance || !preflight || !confirmed) return;
    setError('');
    setLoading(true);
    try {
      const result = await postJson<{ ok: true; executionId: string }>('/api/aws/start', {
        ...credentials,
        region: selectedInstance.region,
        instanceId: selectedInstance.id,
        encrypted: preflight.encrypted,
        confirmed: true,
      });
      setExecutionId(result.executionId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '自动化启动失败。');
    } finally {
      setLoading(false);
    }
  }

  const refreshExecution = useCallback(async () => {
    if (!executionId || !selectedInstance) return;
    try {
      const result = await postJson<{ ok: true; execution: Execution }>('/api/aws/status', {
        ...credentials,
        region: selectedInstance.region,
        executionId,
      });
      setExecution(result.execution);
      setLastUpdated(new Date());
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '获取自动化进度失败。');
    }
  }, [credentials, executionId, selectedInstance]);

  useEffect(() => {
    if (!executionId) return;
    void refreshExecution();
    if (execution && terminalStatuses.has(execution.status)) return;
    const timer = window.setInterval(() => void refreshExecution(), 4000);
    return () => window.clearInterval(timer);
  }, [executionId, execution?.status, refreshExecution]);

  async function loadPrivateKey() {
    if (!execution?.result.linuxKeyParameter || !selectedInstance) return;
    setKeyLoading(true);
    setError('');
    try {
      const result = await postJson<{ ok: true; privateKey: string }>('/api/aws/key', {
        ...credentials,
        region: selectedInstance.region,
        parameterName: execution.result.linuxKeyParameter,
      });
      setPrivateKey(result.privateKey);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '读取新私钥失败。');
    } finally {
      setKeyLoading(false);
    }
  }

  function downloadPrivateKey() {
    if (!privateKey || !selectedInstance) return;
    const blob = new Blob([privateKey], { type: 'application/x-pem-file' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedInstance.id}-cloudrescue.pem`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function clearSession() {
    setCredentials({ accessKeyId: '', secretAccessKey: '' });
    setAccount(null);
    setRegions([]);
    setInstances([]);
    setSelectedInstance(null);
    setPreflight(null);
    setExecutionId('');
    setExecution(null);
    setPrivateKey('');
    setConfirmed(false);
    setError('');
    setStage(1);
  }

  const relevantSteps = execution?.steps.filter((step) => step.status !== 'Skipped') || [];
  const childSteps = execution?.children.flatMap((child) => child.steps) || [];
  const progressSteps = [...relevantSteps, ...childSteps];
  const finishedSteps = progressSteps.filter((step) =>
    ['Success', 'Failed', 'TimedOut', 'Skipped'].includes(step.status),
  ).length;
  const progressValue = progressSteps.length ? Math.round((finishedSteps / progressSteps.length) * 100) : 2;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#111922] text-white">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[#ffb547] text-[#1a1f25] shadow-[0_0_0_1px_rgb(255_255_255/12%)]">
              <CloudCog className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-wide">CloudRescue</p>
              <p className="text-[11px] text-slate-400">EC2 访问恢复中心</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {account ? <span className="hidden font-mono text-xs text-slate-400 sm:block">{account.id}</span> : null}
            <Badge className="border-white/10 bg-white/8 text-slate-200" variant="outline">
              <LockKeyhole /> 安全会话
            </Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b bg-[#16212d] px-5 py-5 text-slate-300 lg:min-h-[calc(100vh-64px)] lg:border-b-0 lg:border-r lg:border-white/6 lg:px-6 lg:py-8">
          <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">恢复流程</p>
          <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
            {steps.map((step) => (
              <li
                key={step.id}
                className={`flex items-center gap-3 rounded-xl px-3 py-3.5 ${
                  step.id === stage ? 'bg-white/8 text-white' : step.id < stage ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-lg text-xs font-semibold ${
                    step.id === stage
                      ? 'bg-[#ffb547] text-[#18212b]'
                      : step.id < stage
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'border border-white/10 bg-white/3'
                  }`}
                >
                  {step.id < stage ? <Check className="size-3.5" /> : step.id}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{step.label}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-8 hidden rounded-xl border border-white/8 bg-black/10 p-4 lg:block">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-300">
              <ShieldCheck className="size-4 text-emerald-400" /> 操作边界
            </div>
            <p className="text-xs leading-5 text-slate-500">
              仅扫描 EC2，并启动 AWS 官方 AWSSupport-ResetAccess 自动化。
            </p>
          </div>
        </aside>

        <section className="min-w-0 px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
          <div className="mx-auto max-w-5xl">
            {error ? (
              <Alert className="mb-5 border-red-200 bg-red-50" variant="destructive">
                <AlertTriangle />
                <AlertTitle>操作没有完成</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {stage === 1 ? (
              <>
                <PageHeading
                  eyebrow="第 1 步，共 3 步"
                  title="连接客户 AWS 账号"
                  description="先在客户的 CloudShell 中创建专用访问凭证，然后返回这里验证账号并扫描 EC2。"
                />
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
                  <div className="space-y-5">
                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader className="border-b border-border/70 pb-4">
                        <IconTitle icon={<TerminalSquare />} title="在 AWS CloudShell 执行授权命令" description="命令会创建专用 IAM 用户和自动化执行角色。" tone="amber" />
                      </CardHeader>
                      <CardContent className="pt-5">
                        <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-[#111922] px-4 py-3 text-slate-200 shadow-inner">
                          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs sm:text-[13px]">
                            <span className="mr-2 select-none text-[#ffb547]">$</span>{cloudShellCommand}
                          </code>
                          <Button className="border-white/10 bg-white/8 text-white hover:bg-white/14" onClick={() => copyText(cloudShellCommand)} size="sm" variant="outline">
                            {copied ? <Check /> : <Clipboard />} {copied ? '已复制' : '复制'}
                          </Button>
                        </div>
                        <p className="mt-3 text-xs leading-5 text-muted-foreground">
                          执行完成后会输出 Access Key ID 和 Secret Access Key。任务完成后请在 IAM 中禁用或删除。
                        </p>
                      </CardContent>
                    </Card>

                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader>
                        <IconTitle icon={<KeyRound />} title="输入专用访问凭证" description="只验证账号身份和扫描 EC2，不会立即修改资源。" tone="blue" />
                      </CardHeader>
                      <CardContent>
                        <form className="space-y-4" onSubmit={scanAccount}>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-slate-700">Access Key ID</span>
                            <Input
                              autoComplete="off"
                              className="h-10 font-mono text-sm"
                              onChange={(event) => setCredentials((value) => ({ ...value, accessKeyId: event.target.value.trim() }))}
                              placeholder="AKIA••••••••••••••••"
                              spellCheck={false}
                              value={credentials.accessKeyId}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-slate-700">Secret Access Key</span>
                            <div className="relative">
                              <Input
                                autoComplete="new-password"
                                className="h-10 pr-10 font-mono text-sm"
                                onChange={(event) => setCredentials((value) => ({ ...value, secretAccessKey: event.target.value.trim() }))}
                                placeholder="输入 Secret Access Key"
                                spellCheck={false}
                                type={showSecret ? 'text' : 'password'}
                                value={credentials.secretAccessKey}
                              />
                              <button
                                aria-label={showSecret ? '隐藏密钥' : '显示密钥'}
                                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                onClick={() => setShowSecret((value) => !value)}
                                type="button"
                              >
                                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                              </button>
                            </div>
                          </label>
                          <Button
                            className="h-10 w-full bg-[#d97808] text-white hover:bg-[#bc6300]"
                            disabled={loading || !credentials.accessKeyId || !credentials.secretAccessKey}
                            size="lg"
                            type="submit"
                          >
                            {loading ? <Spinner /> : <Radar />} {loading ? '正在扫描已启用区域…' : '验证账号并扫描实例'}
                            {!loading ? <ChevronRight /> : null}
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="space-y-5">
                    <Card className="border-0 bg-[#182531] text-white ring-0">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sm text-white"><Radar className="size-4 text-[#ffb547]" />连接后将自动完成</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ol className="space-y-4">
                          {[
                            ['识别账号', '验证凭证所属 AWS Account'],
                            ['扫描区域', '只查询已启用的 AWS Region'],
                            ['汇总实例', '展示运行中的 Windows / Linux EC2'],
                          ].map(([title, detail], index) => (
                            <li className="flex gap-3" key={title}>
                              <span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/12 bg-white/6 text-[11px] font-semibold text-[#ffca78]">{index + 1}</span>
                              <span><span className="block text-xs font-medium text-slate-100">{title}</span><span className="mt-0.5 block text-[11px] leading-5 text-slate-400">{detail}</span></span>
                            </li>
                          ))}
                        </ol>
                      </CardContent>
                    </Card>
                    <SupportCard />
                  </div>
                </div>
              </>
            ) : null}

            {stage === 2 ? (
              <>
                <PageHeading
                  eyebrow={`AWS Account ${account?.id || ''}`}
                  title="选择需要恢复的 EC2"
                  description={`已扫描 ${regions.length} 个启用区域，找到 ${instances.length} 台运行中的实例。`}
                  action={<Button onClick={clearSession} size="sm" variant="outline"><Trash2 />断开连接</Button>}
                />
                <div className="mb-5 flex flex-col gap-3 sm:flex-row">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input className="h-10 pl-9" onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、实例 ID 或 IP" value={search} />
                  </div>
                  <NativeSelect
                    aria-label="区域筛选"
                    className="w-full sm:w-56 [&_select]:h-10"
                    onChange={(event) => setRegionFilter(event.target.value)}
                    value={regionFilter}
                  >
                    <NativeSelectOption value="all">全部区域</NativeSelectOption>
                    {Array.from(new Set(instances.map((instance) => instance.region))).map((region) => <NativeSelectOption key={region} value={region}>{region}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                {scanWarnings.length ? <p className="mb-4 text-xs text-amber-700">有 {scanWarnings.length} 个区域因权限或网络原因未完成扫描。</p> : null}

                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,.6fr)]">
                  <div className="space-y-3">
                    {filteredInstances.length ? filteredInstances.map((instance) => (
                      <button
                        className={`w-full rounded-xl bg-card p-4 text-left shadow-sm ring-1 transition hover:-translate-y-0.5 hover:shadow-md ${selectedInstance?.id === instance.id && selectedInstance.region === instance.region ? 'ring-2 ring-[#d97808]' : 'ring-slate-900/8'}`}
                        key={`${instance.region}:${instance.id}`}
                        onClick={() => void chooseInstance(instance)}
                        type="button"
                      >
                        <div className="flex items-start gap-3">
                          <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${instance.platform === 'Windows' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}><Server className="size-4.5" /></span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div><p className="truncate text-sm font-semibold">{instance.name || '未命名实例'}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{instance.id}</p></div>
                              <div className="flex gap-1.5"><Badge variant="secondary">{instance.platform}</Badge><Badge className="bg-emerald-50 text-emerald-700" variant="secondary">运行中</Badge></div>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                              <span>{instance.region}</span><span>{instance.availabilityZone}</span><span>{instance.type}</span><span className="truncate font-mono">{instance.publicIp || instance.privateIp || '无 IP'}</span>
                            </div>
                          </div>
                        </div>
                      </button>
                    )) : (
                      <Card className="border-dashed bg-transparent py-12 text-center shadow-none"><CardContent><Server className="mx-auto mb-3 size-8 text-slate-300" /><p className="text-sm font-medium">没有匹配的运行中实例</p><p className="mt-1 text-xs text-muted-foreground">请更换搜索词或区域。</p></CardContent></Card>
                    )}
                  </div>

                  <div className="xl:sticky xl:top-5 xl:self-start">
                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader><CardTitle>执行前检查</CardTitle><CardDescription>选择实例后检查根盘、网络和自动扩缩容风险。</CardDescription></CardHeader>
                      <CardContent>
                        {preflightLoading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Spinner />正在读取实例配置…</div> : preflight ? (
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-3 text-xs">
                              <InfoItem label="系统" value={preflight.platform} />
                              <InfoItem label="根设备" value={preflight.rootDeviceType.toUpperCase()} />
                              <InfoItem label="加密" value={preflight.encrypted ? '已加密' : '未加密'} />
                              <InfoItem label="Elastic IP" value={preflight.hasElasticIp ? '已绑定' : '未绑定'} />
                            </div>
                            {preflight.warnings.length ? <div className="space-y-2">{preflight.warnings.map((warning) => <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" key={warning}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{warning}</div>)}</div> : <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700"><CheckCircle2 className="size-4" />基础条件检查通过</div>}
                            <Button className="h-10 w-full bg-[#d97808] text-white hover:bg-[#bc6300]" disabled={!preflight.supported} onClick={() => setStage(3)}>继续恢复 <ChevronRight /></Button>
                          </div>
                        ) : <p className="py-8 text-sm leading-6 text-muted-foreground">请从左侧选择一台需要恢复访问的 EC2。</p>}
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </>
            ) : null}

            {stage === 3 && selectedInstance && preflight ? (
              <>
                <PageHeading
                  eyebrow={`${selectedInstance.region} · ${selectedInstance.id}`}
                  title={executionId ? 'EC2 访问恢复进度' : '确认并启动访问恢复'}
                  description={executionId ? '页面每 4 秒同步一次 AWS Automation 和 EC2Rescue 子流程。' : '启动后实例会停止，AWS 将创建备份 AMI 并执行离线访问恢复。'}
                  action={!executionId ? <Button onClick={() => setStage(2)} size="sm" variant="outline"><ChevronLeft />返回选择</Button> : undefined}
                />

                {!executionId ? (
                  <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader><IconTitle icon={<MonitorCog />} title="即将执行 AWSSupport-ResetAccess" description="AWS 会自动判断 Windows 或 Linux，并进入对应恢复分支。" tone="amber" /></CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <InfoItem label="实例" value={selectedInstance.name || selectedInstance.id} />
                          <InfoItem label="操作系统" value={preflight.platform} />
                          <InfoItem label="可用区" value={preflight.availabilityZone} />
                          <InfoItem label="根卷" value={preflight.rootVolumeId} mono />
                        </div>
                        {preflight.warnings.map((warning) => <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800" key={warning}><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{warning}</div>)}
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-muted/35 p-4">
                          <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(Boolean(value))} />
                          <span className="text-xs leading-5 text-slate-700">我已确认该实例可以停机，并了解公网 IP、Instance Store 和 Auto Scaling 风险。</span>
                        </label>
                        <Button className="h-10 w-full bg-red-600 text-white hover:bg-red-700" disabled={!confirmed || loading} onClick={() => void startRecovery()}>
                          {loading ? <Spinner /> : <ShieldCheck />} {loading ? '正在启动 AWS 自动化…' : '确认停机并开始恢复'}
                        </Button>
                      </CardContent>
                    </Card>
                    <Card className="border-0 bg-[#182531] text-white ring-0"><CardHeader><CardTitle className="text-sm text-white">预计流程</CardTitle></CardHeader><CardContent><ol className="space-y-3 text-xs text-slate-300">{['创建备份 AMI','启动临时救援环境','拆下并挂载根 EBS','注入 SSH Key 或修复 Windows','挂回根盘并恢复实例','清理临时资源'].map((item, index) => <li className="flex gap-2" key={item}><span className="text-[#ffb547]">{String(index + 1).padStart(2, '0')}</span>{item}</li>)}</ol></CardContent></Card>
                  </div>
                ) : (
                  <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,.7fr)]">
                    <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-slate-900/8">
                      <CardHeader className="border-b border-border/70 pb-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div><CardTitle>实时执行步骤</CardTitle><CardDescription className="mt-1 font-mono text-[11px]">{executionId}</CardDescription></div>
                          <Button disabled={!execution} onClick={() => void refreshExecution()} size="sm" variant="outline"><RefreshCw className={execution && !terminalStatuses.has(execution.status) ? 'animate-spin' : ''} />刷新</Button>
                        </div>
                        <Progress className="mt-4" value={progressValue} />
                      </CardHeader>
                      <CardContent>
                        {!execution ? <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Spinner />正在读取第一批执行步骤…</div> : (
                          <div className="relative divide-y divide-border/70 before:absolute before:bottom-5 before:left-3 before:top-5 before:w-px before:bg-border">
                            {execution.steps.map((step) => {
                              const child = execution.children.find(() => {
                                const target = step.name.toLowerCase();
                                return target.includes('ec2rescue') && target.includes(execution.detectedPlatform.toLowerCase());
                              });
                              return <div key={step.id}><StepRow step={step} />{child?.steps.length ? <div className="mb-3 ml-9 rounded-xl border bg-slate-50/70 px-3"><p className="border-b py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">EC2Rescue 详细流程</p>{child.steps.map((childStep) => <StepRow key={childStep.id} nested step={childStep} />)}</div> : null}</div>;
                            })}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <div className="space-y-5 xl:sticky xl:top-5 xl:self-start">
                      <Card className="border-0 bg-[#182531] text-white ring-0">
                        <CardHeader><CardTitle className="text-sm text-white">任务状态</CardTitle></CardHeader>
                        <CardContent>
                          <div className="flex items-center gap-3">
                            <span className="grid size-10 place-items-center rounded-xl bg-white/7">{execution?.status === 'Success' ? <CheckCircle2 className="text-emerald-400" /> : execution?.status === 'Failed' ? <XCircle className="text-red-400" /> : <LoaderCircle className="animate-spin text-[#ffb547]" />}</span>
                            <div><p className="text-sm font-medium">{execution ? statusText(execution.status) : '正在连接'}</p><p className="mt-1 text-[11px] text-slate-400">{execution?.detectedPlatform ? `已识别为 ${execution.detectedPlatform}` : '正在识别操作系统'}</p></div>
                          </div>
                          {lastUpdated ? <p className="mt-4 border-t border-white/8 pt-3 text-[10px] text-slate-500">最后同步：{lastUpdated.toLocaleTimeString('zh-CN')}</p> : null}
                        </CardContent>
                      </Card>

                      {execution?.status === 'Success' ? (
                        <Card className="border-0 shadow-[0_16px_45px_rgb(21_32_43/7%)] ring-1 ring-emerald-700/20">
                          <CardHeader><CardTitle className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="size-4" />恢复任务已完成</CardTitle><CardDescription>请保存恢复结果，并验证实例访问。</CardDescription></CardHeader>
                          <CardContent className="space-y-3">
                            {execution.detectedPlatform === 'Linux' && execution.result.linuxKeyParameter ? <>
                              <InfoItem label="新私钥参数" value={execution.result.linuxKeyParameter} mono />
                              {!privateKey ? <Button className="w-full" disabled={keyLoading} onClick={() => void loadPrivateKey()}>{keyLoading ? <Spinner /> : <FileKey2 />}读取一次新私钥</Button> : <>
                                <div className="rounded-lg bg-slate-950 p-3 font-mono text-[10px] text-slate-300">{privateKey.split('\n').slice(0, 2).join('\n')}<br />••••••••••••••••</div>
                                <Button className="w-full" onClick={downloadPrivateKey}><Download />下载 PEM 私钥</Button>
                              </>}
                              {execution.result.linuxBackupAmi ? <InfoItem label="备份 AMI" value={execution.result.linuxBackupAmi} mono /> : null}
                            </> : null}
                            {execution.detectedPlatform === 'Windows' ? <>
                              <InfoItem label="备份 AMI" value={execution.result.windowsBackupAmi || '等待输出'} mono />
                              <InfoItem label="Password Enabled AMI" value={execution.result.windowsPasswordEnabledAmi || '等待输出'} mono />
                            </> : null}
                            <Button className="w-full" onClick={clearSession} variant="outline"><Trash2 />清除本次凭证</Button>
                          </CardContent>
                        </Card>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#9a5b08]"><CircleDot className="size-3.5" />{eyebrow}</div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</div>;
}

function IconTitle({ icon, title, description, tone }: { icon: React.ReactNode; title: string; description: string; tone: 'amber' | 'blue' }) {
  return <div className="flex items-start gap-3"><span className={`grid size-9 shrink-0 place-items-center rounded-xl [&>svg]:size-4.5 ${tone === 'amber' ? 'bg-[#fff4df] text-[#a45f00]' : 'bg-[#eaf3ff] text-[#1769aa]'}`}>{icon}</span><div><CardTitle>{title}</CardTitle><CardDescription className="mt-1">{description}</CardDescription></div></div>;
}

function InfoItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0 rounded-lg bg-muted/55 px-3 py-2"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 truncate text-xs font-medium text-slate-700 ${mono ? 'font-mono' : ''}`} title={value}>{value || '—'}</p></div>;
}

function SupportCard() {
  return <Card className="border-dashed bg-transparent shadow-none ring-slate-900/10"><CardContent className="py-5"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Server className="size-4.5" /></span><div><p className="text-sm font-medium">同时支持两种系统</p><div className="mt-2 flex flex-wrap gap-2"><Badge variant="secondary">Linux · SSH Key</Badge><Badge variant="secondary">Windows · AMI</Badge></div><p className="mt-3 text-xs leading-5 text-muted-foreground">AWS Automation 会识别系统类型并进入对应的 EC2Rescue 流程。</p></div></div></CardContent></Card>;
}
