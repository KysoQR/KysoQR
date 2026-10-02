import type { Metadata } from 'next';
import { TamThuProvider } from '@/components/TamThu';
import { readTamThuHtml } from '@/lib/tamthu';
import './globals.css';

export const metadata: Metadata = {
  title: 'KysoQR',
  description: 'Ký số PDF qua mã QR — xác minh chữ ký số không cần đăng nhập.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>
        {/* `null` when there is no tamthu.md -- then the header simply has
            no "Tâm thư" button; nothing else depends on it. */}
        <TamThuProvider html={readTamThuHtml()}>{children}</TamThuProvider>
      </body>
    </html>
  );
}
