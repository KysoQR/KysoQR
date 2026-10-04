import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyDocumentPage } from '@/components/VerifyDocumentPage';

export const metadata: Metadata = {
  title: 'Xác minh tài liệu ký — KysoQR',
};

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyDocumentPage />
    </Suspense>
  );
}
