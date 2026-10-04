import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/PlaceholderPage';

export const metadata: Metadata = {
  title: 'Xác minh tài liệu ký — KysoQR',
};

export default function VerifyPage() {
  return <PlaceholderPage titleKey="nav.verifyLabel" />;
}
