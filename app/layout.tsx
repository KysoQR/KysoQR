import type { Metadata } from 'next';
import { connection } from 'next/server';
import { WhyMenuProvider } from '@/components/WhyMenu';
import { readWhyPage } from '@/lib/whyPage';
import './globals.css';

export const metadata: Metadata = {
  title: 'KysoQR',
  description: 'Ký số PDF qua mã QR — xác minh chữ ký số không cần đăng nhập.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per request, so dropping `public/why.html` on the server shows the menu
  // without a rebuild.
  await connection();
  const showWhy = readWhyPage() !== null;
  return (
    <html lang="vi" suppressHydrationWarning>
      {/* In-app browsers (Zalo, Messenger…) inject an inline style on
          <body> before React hydrates -- ignore that, it's not our markup. */}
      <body suppressHydrationWarning>
        <WhyMenuProvider available={showWhy}>{children}</WhyMenuProvider>
      </body>
    </html>
  );
}
