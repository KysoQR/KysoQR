import type { Metadata } from 'next';
import { ApiDocs } from '@/components/ApiDocs';

export const metadata: Metadata = {
  title: 'KysoQR API',
  description: 'Tài liệu API KysoQR — ký số PDF qua QR và xác minh chữ ký số.',
};

export default function DocsPage() {
  return <ApiDocs />;
}
