import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { VneidCertificateCenterPage } from '@/components/vneid/VneidCertificateCenterPage';
import { isVneidClientAllowed } from '@/lib/vneid/access';

export const metadata: Metadata = {
  title: 'Đăng ký & Quản lý Chứng thư số VNeID — KysoQR',
};

/** Only for trusted networks (VNEID_TRUSTED_IPS): anyone else gets a 404. */
export default async function VneidPage() {
  if (!isVneidClientAllowed(await headers())) notFound();
  return (
    <Suspense>
      <VneidCertificateCenterPage />
    </Suspense>
  );
}
