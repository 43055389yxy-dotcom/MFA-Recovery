import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AWS MFA 恢复控制台',
  description: '通过集中式根访问扫描和清除成员账号根凭证，并开放密码恢复。',
};

export default function MfaRecoveryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
