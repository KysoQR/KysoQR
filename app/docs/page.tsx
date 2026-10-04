import { redirect } from 'next/navigation';

/** Old public URL. The reference now lives at `/api`. */
export default function DocsRedirectPage() {
  redirect('/api/');
}
