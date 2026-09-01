import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'CloudRescue · EC2 访问恢复中心',
  description: '扫描客户 AWS 账号中的 EC2，并安全启动官方访问恢复自动化。',
  openGraph: {
    title: 'CloudRescue · EC2 访问恢复中心',
    description: '扫描客户 AWS 账号中的 EC2，并安全启动官方访问恢复自动化。',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'CloudRescue · EC2 访问恢复中心' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CloudRescue · EC2 访问恢复中心',
    description: '扫描客户 AWS 账号中的 EC2，并安全启动官方访问恢复自动化。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
