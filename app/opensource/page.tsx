import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/PlaceholderPage';

export const metadata: Metadata = {
  title: 'Ký số mã nguồn mở — KysoQR',
};

export default function OpenSourcePage() {
  return <PlaceholderPage titleKey="nav.openSourceLabel" />;
}
