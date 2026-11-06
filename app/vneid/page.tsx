import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VneidCertificateCenterPage } from '@/components/vneid/VneidCertificateCenterPage';

export const metadata: Metadata = {
  title: 'Đăng ký & Quản lý Chứng thư số VNeID — KysoQR',
};

export default function VneidPage() {
  return (
    <Suspense>
      <VneidCertificateCenterPage />
    </Suspense>
  );
}

