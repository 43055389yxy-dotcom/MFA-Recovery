import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://cloudrescue-ec2-access.mcarthunkandis.chatgpt.site'),
  title: 'CloudRescue · EC2 智能登录恢复',
  description: '优先使用不停机方案恢复 EC2 登录，在线方案失败后再由用户确认离线救援。',
  openGraph: {
    title: 'CloudRescue · EC2 智能登录恢复',
    description: '优先使用不停机方案恢复 EC2 登录，在线方案失败后再由用户确认离线救援。',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'CloudRescue · EC2 访问恢复中心' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CloudRescue · EC2 智能登录恢复',
    description: '优先使用不停机方案恢复 EC2 登录，在线方案失败后再由用户确认离线救援。',
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
