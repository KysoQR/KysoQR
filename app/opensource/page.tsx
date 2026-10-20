import type { Metadata } from 'next';
import { OpenSourceGuide } from '@/components/OpenSourceGuide';

export const metadata: Metadata = {
  title: 'Ký số mã nguồn mở — KysoQR',
};

export default function OpenSourcePage() {
  return <OpenSourceGuide />;
}
