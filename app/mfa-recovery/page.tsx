'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MailCheck,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  ShieldAlert,
  ShieldCheck,
  Target,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';

type FormState = {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
};

type Preflight = {
  caller: { accountId: string; arn: string };
  organization: {
    id: string;
    managementAccountId: string;
    callerIsManagementAccount: boolean;
  };
  target: { accountId: string; name: string; state: string };
  rootAccess: {
    trustedAccessEnabled: boolean;
    rootSessionsEnabled: boolean;
    rootCredentialsManagementEnabled: boolean;
  };
  delegatedAdmin: {
    configured: boolean;
    matchesTarget: boolean;
    accountId: string;
    name: string;
  };
};

type RootStatus = {
  passwordPresent: boolean;
  accessKeys: Array<{ AccessKeyId?: string; Status?: string }>;
  signingCertificates: Array<{ CertificateId?: string; Status?: string }>;
  mfaDevices: Array<{ SerialNumber?: string }>;
};

type PayerProfile = {
  id: string;
  accountId: string;
  label: string;
  accessKeyMask: string;
  credentialStatus: 'ready' | 'missing';
  lastTargetAccountId: string;
  source: 'saved' | 'test';
};

type ApiResult = Partial<RootStatus> & {
  ok: boolean;
  enabled?: boolean;
  accessKeyMask?: string;
  accountId?: string;
  profiles?: PayerProfile[];
  profile?: PayerProfile;
  deletedProfileId?: string;
  ready?: boolean;
  caller?: { accountId: string; arn: string };
  principal?: string;
  command?: string;
  requiresNewCredentials?: boolean;
  preflight?: Preflight;
  changes?: string[];
  status?: RootStatus;
  emailStatus?: string;
  primaryEmail?: string;
  error?: { message?: string };
};

type EmailUpdateState = 'idle' | 'code-sent' | 'completed';

const stages = [
  { label: '连接账号', detail: '验证主账号' },
  { label: '根访问', detail: '检查状态' },
  { label: '根凭证', detail: '扫描与清除' },
  { label: '密码恢复', detail: '启用恢复' },
  { label: '密码与 MFA', detail: '完成设置' },
];

const createPayerOperatorCommand = [
  "USER_NAME='MfaRecoveryOperator'",
  "POLICY_ARN='arn:aws:iam::aws:policy/AdministratorAccess'",
  'aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1 || \\',
  '  aws iam create-user --user-name "$USER_NAME"',
  'for KEY_ID in $(aws iam list-access-keys --user-name "$USER_NAME" --query \'AccessKeyMetadata[].AccessKeyId\' --output text); do',
  '  [ "$KEY_ID" = "None" ] || aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$KEY_ID"',
  'done',
  'aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"',
  'aws organizations enable-aws-service-access --service-principal account.amazonaws.com',
  'aws iam create-access-key --user-name "$USER_NAME" --output json',
  '',
  '',
].join('\n');

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const apiBase = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://127.0.0.1:3198'
    : '';
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const result = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(result.error?.message || 'AWS 请求失败，请稍后重试。');
  }
  return result;
}

function StatusRow({
  label,
  detail,
  passed,
}: {
  label: string;
  detail: string;
  passed: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
            passed
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-amber-100 text-amber-700'
          }`}
        >
          {passed ? (
            <Check className="size-4" />
          ) : (
            <Circle className="size-4" />
          )}
        </span>
        <div className="min-w-0">
          <p className="font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <Badge variant={passed ? 'secondary' : 'outline'}>
        {passed ? '正常' : '需处理'}
      </Badge>
    </div>
  );
}

function PageActions({
  back,
  primaryLabel,
  onPrimary,
  disabled,
  busy,
  primaryIcon,
  destructive,
}: {
  back?: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  disabled?: boolean;
  busy?: boolean;
  primaryIcon?: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
      {back ? (
        <Button variant="ghost" onClick={back} disabled={busy}>
          <ArrowLeft /> 返回
        </Button>
      ) : (
        <span />
      )}
      <Button
        variant={destructive ? 'destructive' : 'default'}
        onClick={onPrimary}
        disabled={disabled || busy}
        className="h-10 min-w-36 px-4"
      >
        {busy ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          primaryIcon || <ArrowRight />
        )}
        {busy ? '正在处理…' : primaryLabel}
      </Button>
    </div>
  );
}

export default function MfaRecoveryPage() {
  const [form, setForm] = useState<FormState>({
    accessKeyId: '',
    secretAccessKey: '',
    accountId: '',
  });
  const [currentStage, setCurrentStage] = useState(0);
  const [showSecret, setShowSecret] = useState(false);
  const [profiles, setProfiles] = useState<PayerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [addingPayer, setAddingPayer] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [permissionCommand, setPermissionCommand] = useState('');
  const [permissionPrincipal, setPermissionPrincipal] = useState('');
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [newPayerLabel, setNewPayerLabel] = useState('');
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [editingProfileId, setEditingProfileId] = useState('');
  const [profileDeleteCandidate, setProfileDeleteCandidate] =
    useState<PayerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [rootStatus, setRootStatus] = useState<RootStatus | null>(null);
  const [rootDeleted, setRootDeleted] = useState(false);
  const [recoveryAllowed, setRecoveryAllowed] = useState(false);
  const [rootHelpOpen, setRootHelpOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [emailChangeEnabled, setEmailChangeEnabled] = useState(false);
  const [newRootEmail, setNewRootEmail] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailUpdateState, setEmailUpdateState] =
    useState<EmailUpdateState>('idle');

  const canSavePayer = useMemo(
    () =>
      /^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(form.accessKeyId.trim()) &&
      form.secretAccessKey.trim().length >= 30,
    [form.accessKeyId, form.secretAccessKey],
  );

  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId,
  );
  const validRootEmail =
    newRootEmail.trim().length <= 64 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newRootEmail.trim());
  const canUseSaved = Boolean(
    selectedProfileId &&
    selectedProfile?.credentialStatus === 'ready' &&
    /^\d{12}$/.test(form.accountId.trim()) &&
    (!emailChangeEnabled || validRootEmail),
  );
  const editingProfile = profiles.find(
    (profile) => profile.id === editingProfileId,
  );

  const rootReady = Boolean(
    preflight?.rootAccess.trustedAccessEnabled &&
    preflight.rootAccess.rootSessionsEnabled &&
    preflight.rootAccess.rootCredentialsManagementEnabled,
  );

  const requestBody = {
    ...(selectedProfileId
      ? { profileId: selectedProfileId }
      : {
          accessKeyId: form.accessKeyId.trim(),
          secretAccessKey: form.secretAccessKey.trim(),
        }),
    accountId: form.accountId.trim(),
    ...(addingPayer && newPayerLabel.trim()
      ? { label: newPayerLabel.trim() }
      : {}),
  };

  useEffect(() => {
    let active = true;
    void postJson<ApiResult>('/api/aws/mfa/profiles/list', {})
      .then((result) => {
        if (!active) return;
        const availableProfiles = result.profiles || [];
        setProfiles(availableProfiles);
        const first = availableProfiles[0];
        if (first) {
          setSelectedProfileId(first.id);
          setForm((current) => ({
            ...current,
            accountId: '',
          }));
        } else {
          setAddingPayer(true);
          setPermissionCommand(createPayerOperatorCommand);
          setPermissionPrincipal('新账号操作用户');
          setPermissionDialogOpen(true);
        }
      })
      .catch((caught) => {
        if (!active) return;
        setError(
          caught instanceof Error ? caught.message : '读取代付账号失败。',
        );
        setAddingPayer(true);
      })
      .finally(() => {
        if (active) setProfilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function updateField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function resetMessages() {
    setError('');
    setNotice('');
  }

  function resetEmailChange() {
    setEmailChangeEnabled(false);
    setNewRootEmail('');
    setEmailOtp('');
    setEmailUpdateState('idle');
  }

  async function runAction(path: string, body: unknown = requestBody) {
    setBusy(true);
    resetMessages();
    try {
      return await postJson<ApiResult>(path, body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败。');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function selectProfile(profile: PayerProfile) {
    resetMessages();
    resetEmailChange();
    setAddingPayer(false);
    setSelectedProfileId(profile.id);
    setPermissionCommand('');
    setPermissionPrincipal('');
    setCommandCopied(false);
    setNewPayerLabel('');
    setForm({
      accessKeyId: '',
      secretAccessKey: '',
      accountId: '',
    });
  }

  function startAddingPayer() {
    resetMessages();
    setAddingPayer(true);
    setPermissionCommand(createPayerOperatorCommand);
    setPermissionPrincipal('新账号操作用户');
    setCommandCopied(false);
    setPermissionDialogOpen(true);
    setForm((current) => ({
      ...current,
      accessKeyId: '',
      secretAccessKey: '',
    }));
  }

  function startCompletingPayer(profile: PayerProfile) {
    resetMessages();
    setAddingPayer(true);
    setNewPayerLabel(profile.label);
    setPermissionCommand(createPayerOperatorCommand);
    setPermissionPrincipal(profile.label);
    setCommandCopied(false);
    setProfilePickerOpen(false);
    setForm((current) => ({
      ...current,
      accessKeyId: '',
      secretAccessKey: '',
    }));
    setPermissionDialogOpen(true);
  }

  function closePayerDialog() {
    if (busy) return;
    setPermissionDialogOpen(false);
    if (addingPayer) {
      setAddingPayer(false);
      setNewPayerLabel('');
      setForm((current) => ({
        ...current,
        accessKeyId: '',
        secretAccessKey: '',
      }));
    }
    resetMessages();
  }

  async function copyCloudShellCommand() {
    if (!permissionCommand) return;
    await navigator.clipboard.writeText(permissionCommand);
    setCommandCopied(true);
    setNotice('命令已复制。');
  }

  function openLabelEditor(profile: PayerProfile) {
    setProfilePickerOpen(false);
    setEditingProfileId(profile.id);
    setLabelDraft(profile.label);
    setLabelDialogOpen(true);
  }

  function openProfileDelete(profile: PayerProfile) {
    setProfilePickerOpen(false);
    setProfileDeleteCandidate(profile);
  }

  async function saveProfileLabel() {
    if (!editingProfile || !labelDraft.trim()) return;
    const result = await runAction('/api/aws/mfa/profiles/label', {
      profileId: editingProfile.id,
      accountId: form.accountId || editingProfile.lastTargetAccountId,
      label: labelDraft.trim(),
    });
    if (!result?.profile) return;
    const updated = result.profile;
    setProfiles((current) => [
      updated,
      ...current.filter((profile) => profile.accountId !== updated.accountId),
    ]);
    if (selectedProfileId === editingProfile.id) {
      setSelectedProfileId(updated.id);
    }
    setLabelDialogOpen(false);
    setNotice('账号备注已更新。');
  }

  async function deleteProfile() {
    if (!profileDeleteCandidate) return;
    const deletedProfile = profileDeleteCandidate;
    const result = await runAction('/api/aws/mfa/profiles/delete', {
      profileId: deletedProfile.id,
      accountId: deletedProfile.lastTargetAccountId,
    });
    if (!result) return;

    const remainingProfiles = result.profiles || [];
    setProfiles(remainingProfiles);
    setProfileDeleteCandidate(null);

    if (selectedProfileId === deletedProfile.id) {
      const nextProfile = remainingProfiles[0];
      if (nextProfile) {
        setSelectedProfileId(nextProfile.id);
        setAddingPayer(false);
        setForm({
          accessKeyId: '',
          secretAccessKey: '',
          accountId: '',
        });
      } else {
        setSelectedProfileId('');
        setAddingPayer(true);
        setPermissionCommand(createPayerOperatorCommand);
        setPermissionPrincipal('新账号操作用户');
        setCommandCopied(false);
        setForm({ accessKeyId: '', secretAccessKey: '', accountId: '' });
      }
    }
    setNotice('执行账号已删除。');
  }

  async function connect() {
    if (addingPayer) {
      const result = await runAction('/api/aws/mfa/profiles/register', {
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
        ...(newPayerLabel.trim() ? { label: newPayerLabel.trim() } : {}),
      });
      if (!result) return;
      if (!result.ready) {
        setPermissionCommand(result.command || '');
        setPermissionPrincipal(result.principal || '当前 AWS 身份');
        setCommandCopied(false);
        setPermissionDialogOpen(true);
        return;
      }
      if (!result.profile) return;

      const savedProfile = result.profile;
      setProfiles((current) => [
        savedProfile,
        ...current.filter(
          (profile) => profile.accountId !== savedProfile.accountId,
        ),
      ]);
      setSelectedProfileId(savedProfile.id);
      setAddingPayer(false);
      setPermissionCommand('');
      setPermissionPrincipal('');
      setPermissionDialogOpen(false);
      setNewPayerLabel('');
      setForm({ accessKeyId: '', secretAccessKey: '', accountId: '' });
      setNotice('执行账号已保存。');
      return;
    }

    if (selectedProfileId) {
      setBusy(true);
      resetMessages();
      try {
        const latest = await postJson<ApiResult>(
          '/api/aws/mfa/profiles/list',
          {},
        );
        const latestProfiles = latest.profiles || [];
        setProfiles(latestProfiles);
        const currentStillExists = latestProfiles.find(
          (profile) => profile.id === selectedProfileId,
        );
        if (!currentStillExists) {
          const nextProfile = latestProfiles[0];
          if (nextProfile) {
            setSelectedProfileId(nextProfile.id);
            setForm({
              accessKeyId: '',
              secretAccessKey: '',
              accountId: '',
            });
            setNotice(`账号列表已更新，当前选择“${nextProfile.label}”。`);
          } else {
            setSelectedProfileId('');
            setAddingPayer(true);
            setPermissionCommand(createPayerOperatorCommand);
            setPermissionPrincipal('新账号操作用户');
            setCommandCopied(false);
            setForm({ accessKeyId: '', secretAccessKey: '', accountId: '' });
            setPermissionDialogOpen(true);
            setNotice('暂无可用执行账号。');
          }
          return;
        }
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : '同步账号列表失败。',
        );
        return;
      } finally {
        setBusy(false);
      }
    }

    const connectionBody = requestBody;
    const result = await runAction(
      '/api/aws/mfa/profiles/connect',
      connectionBody,
    );
    if (!result) return;
    if (!result.ready) {
      setPermissionCommand(result.command || '');
      setPermissionPrincipal(result.principal || '当前 AK 所属身份');
      setCommandCopied(false);
      setPermissionDialogOpen(true);
      return;
    }
    if (!result.preflight) return;
    setPermissionCommand('');
    setPermissionPrincipal('');
    setPermissionDialogOpen(false);
    if (result.profile) {
      setProfiles((current) => [
        result.profile as PayerProfile,
        ...current.filter(
          (profile) => profile.accountId !== result.profile?.accountId,
        ),
      ]);
      setSelectedProfileId(result.profile.id);
      setForm((current) => ({
        accessKeyId: '',
        secretAccessKey: '',
        accountId: current.accountId,
      }));
    }
    setPreflight(result.preflight);
    setRootStatus(null);
    setRootDeleted(false);
    setRecoveryAllowed(false);
    setCurrentStage(1);
    const ready =
      result.preflight.rootAccess.trustedAccessEnabled &&
      result.preflight.rootAccess.rootSessionsEnabled &&
      result.preflight.rootAccess.rootCredentialsManagementEnabled;
    if (ready) {
      setNotice('账号验证通过。');
      if (!emailChangeEnabled) {
        await scanRootCredentials(connectionBody);
      }
    } else {
      setRootHelpOpen(true);
    }
  }

  async function refreshRootAccess() {
    const result = await runAction('/api/aws/mfa/preflight');
    if (!result?.preflight) return;
    setPreflight(result.preflight);
    const ready =
      result.preflight.rootAccess.trustedAccessEnabled &&
      result.preflight.rootAccess.rootSessionsEnabled &&
      result.preflight.rootAccess.rootCredentialsManagementEnabled;
    if (ready) {
      setRootHelpOpen(false);
      setNotice('集中式根访问已启用。');
      if (!emailChangeEnabled) {
        await scanRootCredentials();
      }
    } else {
      setRootHelpOpen(true);
      setError('仍未检测到完整的集中式根访问设置。');
    }
  }

  async function enableRootAccess() {
    const result = await runAction('/api/aws/mfa/root/enable');
    if (!result?.preflight) return;
    setPreflight(result.preflight);
    const ready =
      result.preflight.rootAccess.trustedAccessEnabled &&
      result.preflight.rootAccess.rootSessionsEnabled &&
      result.preflight.rootAccess.rootCredentialsManagementEnabled;
    if (!ready) {
      setRootHelpOpen(true);
      setError('自动启用后仍未检测到完整的集中式根访问设置。');
      return;
    }
    setRootHelpOpen(false);
    setNotice(
      result.changes?.length
        ? `${result.changes.join('、')}。`
        : '集中式根访问已经处于启用状态。',
    );
    if (!emailChangeEnabled) {
      await scanRootCredentials();
    }
  }

  async function scanRootCredentials(body: unknown = requestBody) {
    const result = await runAction('/api/aws/mfa/root/status', body);
    if (!result) return;
    const status = {
      passwordPresent: Boolean(result.passwordPresent),
      accessKeys: result.accessKeys || [],
      signingCertificates: result.signingCertificates || [],
      mfaDevices: result.mfaDevices || [],
    };
    setRootStatus(status);
    const credentialsFound = Boolean(
      status.passwordPresent ||
      status.accessKeys.length ||
      status.signingCertificates.length ||
      status.mfaDevices.length,
    );
    if (credentialsFound) {
      setCurrentStage(2);
      setNotice('根凭证扫描完成。');
      return;
    }
    setRootDeleted(true);
    setCurrentStage(3);
    setNotice('未发现根凭证。');
    await allowRecovery(body, '未发现根凭证');
  }

  async function sendEmailCode() {
    const result = await runAction('/api/aws/mfa/email/start', {
      ...requestBody,
      primaryEmail: newRootEmail.trim(),
    });
    if (!result) return;
    setEmailOtp('');
    setEmailUpdateState('code-sent');
    setNotice('验证码已发送。');
  }

  async function confirmEmailUpdate() {
    const result = await runAction('/api/aws/mfa/email/accept', {
      ...requestBody,
      primaryEmail: newRootEmail.trim(),
      otp: emailOtp.trim(),
    });
    if (!result) return;
    setEmailUpdateState('completed');
    setNotice('根邮箱已更新。');
    await scanRootCredentials();
  }

  async function deleteCredentials() {
    const result = await runAction('/api/aws/mfa/root/delete', {
      ...requestBody,
      confirmationAccountId: form.accountId,
    });
    if (!result) return;
    setRootStatus(
      result.status || {
        passwordPresent: false,
        accessKeys: [],
        signingCertificates: [],
        mfaDevices: [],
      },
    );
    setRootDeleted(true);
    setDeleteDialogOpen(false);
    setCurrentStage(3);
    setNotice('根凭证已清除。');
    await allowRecovery(requestBody, '根凭证已清除');
  }

  async function allowRecovery(
    body: unknown = requestBody,
    credentialResult = '根凭证处理完成',
  ) {
    const result = await runAction('/api/aws/mfa/root/recover', body);
    if (!result) return;
    setRecoveryAllowed(true);
    setCurrentStage(4);
    setNotice(`${credentialResult}，密码恢复已启用。`);
  }

  function openDeleteConfirmation() {
    resetMessages();
    setDeleteDialogOpen(true);
  }

  async function finishRecovery() {
    if (preflight?.delegatedAdmin.matchesTarget) {
      const result = await runAction('/api/aws/mfa/cleanup');
      if (!result) return;
    }
    resetFlow();
    setNotice('恢复完成。');
  }

  function goBack() {
    resetMessages();
    setCurrentStage((stage) => Math.max(0, stage - 1));
  }

  function resetFlow() {
    resetMessages();
    resetEmailChange();
    setForm((current) => ({
      ...current,
      accountId: '',
    }));
    setCurrentStage(0);
    setPreflight(null);
    setRootStatus(null);
    setRootDeleted(false);
    setRecoveryAllowed(false);
  }

  return (
    <main className="relative isolate min-h-screen overflow-x-hidden bg-[#f4f6f9]">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[linear-gradient(rgba(15,23,42,.018)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.018)_1px,transparent_1px)] bg-[size:40px_40px]" />
      <header className="sticky top-0 z-30 border-b border-white/10 bg-slate-950 text-white shadow-lg shadow-slate-950/10">
        <div className="relative mx-auto flex h-16 max-w-6xl items-center gap-5 px-4 sm:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="relative flex size-8 items-center justify-center rounded-lg bg-primary text-white shadow-lg shadow-primary/20">
              <ShieldCheck className="size-4.5" />
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-slate-950" />
            </div>
            <h1 className="text-sm font-semibold tracking-wide sm:text-base">
              MFA Recovery
            </h1>
          </div>

          <div className="hidden min-w-0 flex-1 items-center justify-center md:flex">
            {stages.map((stage, index) => {
              const active = index === currentStage;
              const complete = index < currentStage;
              return (
                <div key={stage.label} className="flex items-center">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`flex size-6 items-center justify-center rounded-full text-[10px] font-bold transition-all duration-300 ${
                        complete
                          ? 'bg-emerald-500 text-white'
                          : active
                            ? 'bg-primary text-white ring-4 ring-primary/20'
                            : 'bg-white/8 text-white/40'
                      }`}
                    >
                      {complete ? <Check className="size-3" /> : index + 1}
                    </span>
                    <span
                      className={`hidden text-xs lg:inline ${
                        active ? 'text-white' : 'text-white/45'
                      }`}
                    >
                      {stage.label}
                    </span>
                  </div>
                  {index < stages.length - 1 ? (
                    <span
                      className={`mx-2 h-px w-5 lg:w-8 ${
                        complete ? 'bg-emerald-500/70' : 'bg-white/10'
                      }`}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="ml-auto shrink-0 text-right">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40">
              Step {currentStage + 1} / {stages.length}
            </p>
            <p className="text-xs font-medium text-white/90">
              {stages[currentStage].label}
            </p>
          </div>

          <Progress
            value={((currentStage + 1) / stages.length) * 100}
            className="absolute inset-x-0 bottom-0 gap-0 md:hidden [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none [&_[data-slot=progress-track]]:bg-white/10"
          />
        </div>
      </header>

      <section className="relative mx-auto max-w-5xl px-4 py-7 sm:px-6 sm:py-9">
        {error ? (
          <Alert
            variant="destructive"
            className="mb-5 bg-red-50 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300"
          >
            <XCircle />
            <AlertTitle>操作失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert className="mb-5 border-emerald-200 bg-emerald-50 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
            <CheckCircle2 className="text-emerald-700" />
            <AlertDescription className="text-emerald-800">
              {notice}
            </AlertDescription>
          </Alert>
        ) : null}

        {currentStage === 0 ? (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="mb-6">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                  账号接入
                </p>
                <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                  新建恢复任务
                </h2>
              </div>
            </div>

            <Card className="gap-0 overflow-hidden rounded-2xl border-slate-200 bg-white py-0 shadow-[0_18px_50px_-32px_rgba(15,23,42,.42)] ring-1 ring-white">
              <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-slate-50/75 px-5 py-4 sm:px-6">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-950 text-amber-300 shadow-sm">
                    <Building2 className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-950">
                      任务配置
                    </p>
                  </div>
                </div>
              </div>
              <CardContent className="p-5 sm:p-6">
                {profilesLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                    <LoaderCircle className="animate-spin text-primary" />
                    正在读取账号…
                  </div>
                ) : (
                  <>
                    {selectedProfile ? (
                      <div className="animate-in fade-in duration-200">
                        <div className="grid gap-4 lg:grid-cols-2">
                          <section className="relative rounded-2xl border border-slate-200 bg-slate-50/55 p-4 sm:p-5">
                            <span className="absolute right-4 top-4 font-mono text-[10px] font-semibold tracking-[0.16em] text-slate-300">
                              01
                            </span>
                            <div className="mb-4 flex items-center gap-3">
                              <span className="flex size-8 items-center justify-center rounded-lg bg-white text-slate-700 shadow-sm ring-1 ring-slate-200">
                                <KeyRound className="size-4" />
                              </span>
                              <div>
                                <label
                                  htmlFor="payer-profile"
                                  className="text-sm font-semibold text-slate-900"
                                >
                                  执行账号
                                </label>
                              </div>
                            </div>
                            <Popover
                              open={profilePickerOpen}
                              onOpenChange={setProfilePickerOpen}
                            >
                              <PopoverTrigger
                                id="payer-profile"
                                className="flex h-16 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3.5 text-sm shadow-sm outline-none transition-all hover:border-slate-300 hover:shadow-md focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/35"
                              >
                                <span className="flex min-w-0 items-center gap-2.5">
                                  <span
                                    className={`size-2.5 shrink-0 rounded-full ring-4 ${
                                      selectedProfile.credentialStatus ===
                                      'ready'
                                        ? 'bg-emerald-500 ring-emerald-500/10'
                                        : 'bg-amber-500 ring-amber-500/10'
                                    }`}
                                  />
                                  <span className="flex min-w-0 flex-col items-start">
                                    <span className="truncate font-semibold text-slate-900">
                                      {selectedProfile.label}
                                    </span>
                                    <span className="font-mono text-[10px] text-slate-500">
                                      {selectedProfile.accountId}
                                    </span>
                                  </span>
                                </span>
                                <ChevronDown
                                  className={`size-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                                    profilePickerOpen ? 'rotate-180' : ''
                                  }`}
                                />
                              </PopoverTrigger>
                              <PopoverContent
                                align="start"
                                sideOffset={6}
                                className="w-(--anchor-width) min-w-80 gap-1 rounded-xl p-1.5"
                              >
                                {profiles.map((profile) => (
                                  <div
                                    key={profile.id}
                                    className={`group flex items-center gap-1 rounded-lg transition-colors ${
                                      profile.id === selectedProfileId
                                        ? 'bg-primary/8'
                                        : 'hover:bg-slate-50'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        selectProfile(profile);
                                        setProfilePickerOpen(false);
                                      }}
                                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                                    >
                                      <span
                                        className={`size-2 shrink-0 rounded-full ${
                                          profile.credentialStatus === 'ready'
                                            ? 'bg-emerald-500'
                                            : 'bg-amber-500'
                                        }`}
                                      />
                                      <span className="flex min-w-0 flex-1 flex-col items-start">
                                        <span className="truncate font-medium">
                                          {profile.label}
                                        </span>
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                          {profile.accountId} ·{' '}
                                          {profile.accessKeyMask}
                                        </span>
                                      </span>
                                      {profile.id === selectedProfileId ? (
                                        <Check className="size-4 shrink-0 text-primary" />
                                      ) : null}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openLabelEditor(profile)}
                                      className="flex size-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-primary hover:shadow-sm"
                                      aria-label={`编辑 ${profile.label} 的备注`}
                                    >
                                      <Pencil className="size-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openProfileDelete(profile)}
                                      className="mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                      aria-label={`删除 ${profile.label}`}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </PopoverContent>
                            </Popover>
                          </section>

                          <section className="relative rounded-2xl border border-slate-200 bg-slate-50/55 p-4 sm:p-5">
                            <span className="absolute right-4 top-4 font-mono text-[10px] font-semibold tracking-[0.16em] text-slate-300">
                              02
                            </span>
                            <div className="mb-4 flex items-center gap-3">
                              <span className="flex size-8 items-center justify-center rounded-lg bg-white text-slate-700 shadow-sm ring-1 ring-slate-200">
                                <Target className="size-4" />
                              </span>
                              <div>
                                <label
                                  htmlFor="target-account-id"
                                  className="text-sm font-semibold text-slate-900"
                                >
                                  本次目标账号
                                </label>
                              </div>
                            </div>
                            <div className="relative">
                              <Target className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                              <Input
                                id="target-account-id"
                                value={form.accountId}
                                onChange={(event) => {
                                  setEmailOtp('');
                                  setEmailUpdateState('idle');
                                  updateField(
                                    'accountId',
                                    event.target.value
                                      .replace(/\D/g, '')
                                      .slice(0, 12),
                                  );
                                }}
                                placeholder="输入 12 位成员账号 ID"
                                inputMode="numeric"
                                autoComplete="off"
                                className="h-16 rounded-xl border-slate-200 bg-white pl-10 pr-3.5 font-mono text-base tracking-[0.1em] shadow-sm transition-all hover:border-slate-300 focus-visible:shadow-md"
                              />
                            </div>
                            <div className="mt-4 border-t border-slate-200 pt-4">
                              <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2.5">
                                  <MailCheck className="size-4 text-slate-500" />
                                  <label
                                    htmlFor="change-root-email"
                                    className="text-sm font-medium text-slate-800"
                                  >
                                    更换根邮箱
                                  </label>
                                  <Badge variant="outline" className="text-[10px]">
                                    可选
                                  </Badge>
                                </div>
                                <Switch
                                  id="change-root-email"
                                  checked={emailChangeEnabled}
                                  onCheckedChange={(checked) => {
                                    setEmailChangeEnabled(checked);
                                    setEmailOtp('');
                                    setEmailUpdateState('idle');
                                    if (!checked) setNewRootEmail('');
                                  }}
                                />
                              </div>
                              {emailChangeEnabled ? (
                                <div className="relative mt-3 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <MailCheck className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                                  <Input
                                    value={newRootEmail}
                                    onChange={(event) => {
                                      setNewRootEmail(event.target.value.slice(0, 64));
                                      setEmailOtp('');
                                      setEmailUpdateState('idle');
                                    }}
                                    type="email"
                                    placeholder="新根邮箱"
                                    autoComplete="off"
                                    spellCheck={false}
                                    className="h-11 rounded-xl bg-white pl-10 shadow-sm"
                                  />
                                </div>
                              ) : null}
                            </div>
                          </section>
                        </div>

                        <div className="mt-5 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
                          <Button
                            variant="ghost"
                            onClick={startAddingPayer}
                            className="justify-start text-slate-600 hover:text-slate-950"
                          >
                            <Plus /> 添加新账号
                          </Button>
                          <Button
                            className="h-10 min-w-36 px-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                            onClick={() =>
                              selectedProfile.credentialStatus === 'missing'
                                ? startCompletingPayer(selectedProfile)
                                : connect()
                            }
                            disabled={
                              selectedProfile.credentialStatus === 'ready'
                                ? !canUseSaved || busy
                                : busy
                            }
                          >
                            {busy ? (
                              <LoaderCircle className="animate-spin" />
                            ) : (
                              <ArrowRight />
                            )}
                            {busy
                              ? '正在验证…'
                              : selectedProfile.credentialStatus === 'missing'
                                ? '补充凭证'
                                : '开始恢复'}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {!selectedProfile ? (
                      <div className="flex min-h-52 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/60">
                        <Button onClick={startAddingPayer}>
                          <Plus /> 添加账号
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {currentStage === 1 && preflight ? (
          <Card className="animate-in fade-in slide-in-from-bottom-3 duration-500">
            <CardHeader className="border-b">
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck className="size-5" />
              </div>
              <CardTitle className="text-2xl">集中式根访问</CardTitle>
              <CardDescription>
                {preflight.target.name || '目标成员账号'} ·{' '}
                {preflight.target.accountId}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-1">
              <StatusRow
                label="IAM Organizations 可信访问"
                detail={
                  preflight.rootAccess.trustedAccessEnabled
                    ? '已开启'
                    : '未开启'
                }
                passed={preflight.rootAccess.trustedAccessEnabled}
              />
              <StatusRow
                label="根凭证管理"
                detail={
                  preflight.rootAccess.rootCredentialsManagementEnabled
                    ? '已开启'
                    : '未开启'
                }
                passed={preflight.rootAccess.rootCredentialsManagementEnabled}
              />
              <StatusRow
                label="成员账号特权根操作"
                detail={
                  preflight.rootAccess.rootSessionsEnabled ? '已开启' : '未开启'
                }
                passed={preflight.rootAccess.rootSessionsEnabled}
              />
              {rootReady ? (
                emailChangeEnabled ? (
                  <section className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3.5">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-amber-300">
                        <MailCheck className="size-4.5" />
                      </span>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-950">
                          更换根邮箱
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {newRootEmail}
                        </p>
                      </div>
                    </div>

                    <div className="p-4 sm:p-5">
                      {emailUpdateState === 'idle' ? (
                        <PageActions
                          back={goBack}
                          primaryLabel="发送验证码"
                          onPrimary={sendEmailCode}
                          disabled={!validRootEmail}
                          busy={busy}
                          primaryIcon={<MailCheck />}
                        />
                      ) : null}

                      {emailUpdateState === 'code-sent' ? (
                        <div className="animate-in fade-in duration-200">
                          <label
                            htmlFor="root-email-otp"
                            className="mb-3 block text-sm font-medium text-slate-800"
                          >
                            邮箱验证码
                          </label>
                          <InputOTP
                            id="root-email-otp"
                            maxLength={6}
                            value={emailOtp}
                            onChange={(value) =>
                              setEmailOtp(value.replace(/[^A-Za-z0-9]/g, ''))
                            }
                            onComplete={() => {
                              if (!busy) void confirmEmailUpdate();
                            }}
                            containerClassName="w-full"
                          >
                            <InputOTPGroup className="grid w-full grid-cols-6 gap-2">
                              {Array.from({ length: 6 }, (_, index) => (
                                <InputOTPSlot
                                  key={index}
                                  index={index}
                                  className="h-12 w-full rounded-xl border bg-slate-50 font-mono text-lg uppercase first:rounded-xl first:border last:rounded-xl"
                                />
                              ))}
                            </InputOTPGroup>
                          </InputOTP>
                          <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
                            <Button
                              variant="ghost"
                              onClick={sendEmailCode}
                              disabled={busy}
                            >
                              <RefreshCw /> 重新发送
                            </Button>
                            <Button
                              onClick={confirmEmailUpdate}
                              disabled={emailOtp.length !== 6 || busy}
                              className="h-10 min-w-36"
                            >
                              {busy ? (
                                <LoaderCircle className="animate-spin" />
                              ) : (
                                <Check />
                              )}
                              {busy ? '正在验证…' : '确认更换'}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {emailUpdateState === 'completed' ? (
                        <StatusRow
                          label="根邮箱"
                          detail={newRootEmail}
                          passed
                        />
                      ) : null}
                    </div>
                  </section>
                ) : (
                  <div className="mt-4 flex items-center gap-3 rounded-2xl border border-primary/15 bg-primary/5 p-4 animate-in fade-in duration-300">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                      <LoaderCircle className="size-5 animate-spin" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">正在扫描根凭证</p>
                    </div>
                    {!busy && error ? (
                      <Button
                        variant="outline"
                        onClick={() => scanRootCredentials()}
                      >
                        <RefreshCw /> 重试
                      </Button>
                    ) : null}
                  </div>
                )
              ) : (
                <PageActions
                  back={goBack}
                  primaryLabel="重新检测"
                  onPrimary={refreshRootAccess}
                  busy={busy}
                  primaryIcon={<RefreshCw />}
                />
              )}
            </CardContent>
          </Card>
        ) : null}

        {currentStage === 2 && rootStatus ? (
          <Card className="animate-in fade-in slide-in-from-bottom-3 duration-500">
            <CardHeader className="border-b">
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldAlert className="size-5" />
              </div>
              <CardTitle className="text-2xl">根凭证扫描结果</CardTitle>
              <CardDescription>账号 {form.accountId}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 pt-1">
              <StatusRow
                label="根用户密码"
                detail={rootStatus.passwordPresent ? '存在' : '不存在'}
                passed={!rootStatus.passwordPresent}
              />
              <StatusRow
                label="根用户 MFA"
                detail={`${rootStatus.mfaDevices.length} 个设备`}
                passed={rootStatus.mfaDevices.length === 0}
              />
              <StatusRow
                label="根访问密钥"
                detail={`${rootStatus.accessKeys.length} 个`}
                passed={rootStatus.accessKeys.length === 0}
              />
              <StatusRow
                label="根签名证书"
                detail={`${rootStatus.signingCertificates.length} 个`}
                passed={rootStatus.signingCertificates.length === 0}
              />
              <PageActions
                back={goBack}
                primaryLabel="清除根凭证"
                onPrimary={openDeleteConfirmation}
                primaryIcon={<Trash2 />}
                destructive
              />
            </CardContent>
          </Card>
        ) : null}

        {currentStage === 3 ? (
          <Card className="animate-in fade-in slide-in-from-bottom-3 duration-500">
            <CardHeader className="border-b">
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                <MailCheck className="size-5" />
              </div>
              <CardTitle className="text-2xl">启用密码恢复</CardTitle>
              <CardDescription>账号 {form.accountId}</CardDescription>
            </CardHeader>
            <CardContent className="pt-1">
              <StatusRow
                label="根凭证"
                detail={rootDeleted ? '已清除' : '待处理'}
                passed={rootDeleted}
              />
              <div className="mt-4 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
                {busy ? (
                  <LoaderCircle className="size-5 animate-spin" />
                ) : (
                  <MailCheck className="size-5" />
                )}
                <div className="flex-1">
                  <p className="font-medium">
                    {busy ? '正在启用密码恢复' : '密码恢复未启用'}
                  </p>
                </div>
                {!busy ? (
                  <Button
                    onClick={() => allowRecovery()}
                    disabled={!rootDeleted}
                  >
                    <RefreshCw /> 重试
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {currentStage === 4 ? (
          <Card className="animate-in fade-in slide-in-from-bottom-3 duration-500">
            <CardHeader className="border-b">
              <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MailCheck className="size-5" />
              </div>
              <CardTitle className="text-2xl">密码与 MFA</CardTitle>
              <CardDescription>账号 {form.accountId}</CardDescription>
            </CardHeader>
            <CardContent className="pt-1">
              <ol className="space-y-3 text-sm">
                <li className="flex gap-3 rounded-xl border bg-card p-4">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    1
                  </span>
                  <span>打开 AWS 根用户登录页，点击“Forgot password?”。</span>
                </li>
                <li className="flex gap-3 rounded-xl border bg-card p-4">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                    2
                  </span>
                  <span>完成密码重置并绑定 MFA。</span>
                </li>
              </ol>
              <div className="mt-6 flex justify-end border-t pt-5">
                <Button
                  size="lg"
                  className="h-11 min-w-32"
                  onClick={finishRecovery}
                  disabled={!recoveryAllowed || busy}
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  完成
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </section>

      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑账号备注</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {editingProfile?.accountId}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value.slice(0, 40))}
            placeholder="输入便于识别的名称"
            className="h-10"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && labelDraft.trim() && !busy) {
                void saveProfileLabel();
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLabelDialogOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              onClick={saveProfileLabel}
              disabled={!labelDraft.trim() || busy}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
              保存备注
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(profileDeleteCandidate)}
        onOpenChange={(open) => {
          if (!open && !busy) setProfileDeleteCandidate(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-red-100 text-red-700">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>删除已保存账号</AlertDialogTitle>
            <AlertDialogDescription>
              {profileDeleteCandidate?.label} ·{' '}
              <span className="font-mono">
                {profileDeleteCandidate?.accountId}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border border-red-100 bg-red-50/70 p-3 text-xs leading-5 text-red-900">
            仅删除系统记录；AWS IAM 资源不受影响。
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={deleteProfile}
              disabled={busy}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {busy ? '正在删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={permissionDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setPermissionDialogOpen(true);
          } else {
            closePayerDialog();
          }
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="max-h-[calc(100vh-2rem)] overflow-y-auto border-white/80 p-0 sm:max-w-xl"
        >
          <div className="relative border-b bg-[radial-gradient(circle_at_top_left,oklch(0.95_0.055_75),white_72%)] px-6 py-6">
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,.035)_1px,transparent_1px)] bg-[size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
            <div className="relative flex items-center gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-amber-300 shadow-lg shadow-slate-950/15">
                <SquareTerminal className="size-5" />
              </span>
              <DialogHeader className="gap-1">
                <DialogTitle className="text-xl tracking-tight">
                  {addingPayer ? '添加执行账号' : '补充账号权限'}
                </DialogTitle>
                <DialogDescription>
                  {addingPayer
                    ? '访问凭证配置'
                    : `${permissionPrincipal || '当前身份'} 缺少所需权限`}
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>

          <div className="space-y-5 px-6 py-5">
            <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">
                  1
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-950">授权命令</p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    执行位置：AWS CloudShell
                  </p>
                </div>
              </div>
              <Button
                variant={commandCopied ? 'secondary' : 'default'}
                onClick={copyCloudShellCommand}
                disabled={!permissionCommand}
                className="mt-4 h-10 w-full transition-all duration-200"
              >
                {commandCopied ? <CheckCircle2 /> : <Copy />}
                {commandCopied ? '已复制' : '复制命令'}
              </Button>
            </section>

            {addingPayer ? (
              <section className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">
                    2
                  </span>
                  <div>
                    <p className="font-medium text-slate-950">访问凭证</p>
                  </div>
                </div>

                {error ? (
                  <Alert variant="destructive" className="bg-red-50">
                    <XCircle />
                    <AlertTitle>添加失败</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-2">
                  <label
                    htmlFor="dialog-payer-label"
                    className="text-xs font-medium text-slate-600"
                  >
                    账号备注
                  </label>
                  <Input
                    id="dialog-payer-label"
                    value={newPayerLabel}
                    onChange={(event) =>
                      setNewPayerLabel(event.target.value.slice(0, 40))
                    }
                    placeholder="账号备注"
                    className="h-10 rounded-xl bg-slate-50/70 shadow-none"
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="dialog-access-key"
                    className="text-xs font-medium text-slate-600"
                  >
                    Access Key ID
                  </label>
                  <Input
                    id="dialog-access-key"
                    value={form.accessKeyId}
                    onChange={(event) =>
                      updateField(
                        'accessKeyId',
                        event.target.value.toUpperCase(),
                      )
                    }
                    placeholder="AKIA…"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-10 rounded-xl font-mono shadow-none"
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="dialog-secret-key"
                    className="text-xs font-medium text-slate-600"
                  >
                    Secret Access Key
                  </label>
                  <div className="relative">
                    <Input
                      id="dialog-secret-key"
                      value={form.secretAccessKey}
                      onChange={(event) =>
                        updateField('secretAccessKey', event.target.value)
                      }
                      type={showSecret ? 'text' : 'password'}
                      placeholder="输入 Secret Access Key"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-10 rounded-xl pr-11 font-mono shadow-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret((visible) => !visible)}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={
                        showSecret
                          ? '隐藏 Secret Access Key'
                          : '显示 Secret Access Key'
                      }
                    >
                      {showSecret ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <p className="rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                权限更新后重新执行检测。
              </p>
            )}
          </div>

          {addingPayer ? (
            <DialogFooter className="mx-0 mb-0 rounded-none border-t bg-slate-50/80 px-6 py-4">
              {profiles.length ? (
                <Button
                  variant="outline"
                  onClick={closePayerDialog}
                  disabled={busy}
                >
                  取消
                </Button>
              ) : null}
              <Button
                onClick={connect}
                disabled={!canSavePayer || busy}
                className="min-w-40"
              >
                {busy ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <ShieldCheck />
                )}
                {busy ? '正在验证…' : '保存'}
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={rootHelpOpen} onOpenChange={setRootHelpOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl">启用集中式根访问</DialogTitle>
            <DialogDescription>
              使用当前管理账号凭证为整个 AWS Organization 启用所需能力。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>程序将自动补齐以下未启用的组织级设置：</p>
            <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
              <li>IAM Organizations 可信访问</li>
              <li>根凭证管理</li>
              <li>成员账号特权根操作</li>
            </ul>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={refreshRootAccess}
              disabled={busy}
            >
              <RefreshCw />
              仅重新检测
            </Button>
            <Button onClick={enableRootAccess} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
              {busy ? '正在启用…' : '自动启用并继续'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="overflow-hidden gap-0 p-0 sm:max-w-md">
          <AlertDialogHeader className="block border-b bg-red-50/70 px-6 py-6 text-center sm:place-items-center sm:text-center">
            <AlertDialogMedia className="mx-auto mb-4 bg-red-100 text-red-700">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle className="text-xl sm:col-start-auto">
              清除根凭证
            </AlertDialogTitle>
            <AlertDialogDescription className="mt-2">
              目标账号 <strong className="font-mono">{form.accountId}</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t bg-secondary/20 px-6 py-4">
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={deleteCredentials}
              disabled={busy}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {busy ? '正在清除…' : '确认清除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
