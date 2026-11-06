/**
 * Helper to match CA / Provider codes & names to brand logo assets.
 */

export interface ProviderBrandInfo {
  logo: string;
  alt: string;
}

export function getProviderLogo(
  providerCode?: string | null,
  providerName?: string | null
): ProviderBrandInfo | null {
  const code = (providerCode || '').toLowerCase().trim();
  const name = (providerName || '').toLowerCase().trim();

  // 1. FPT IS
  if (code.includes('fpt') || name.includes('fpt')) {
    return { logo: '/brand/providers/fpt.svg', alt: 'FPT IS' };
  }

  // 2. VNPT SmartCA
  if (code.includes('vnpt') || name.includes('bưu chính viễn thông') || name.includes('vnpt')) {
    return { logo: '/brand/providers/vnpt-smartca.svg', alt: 'VNPT SmartCA' };
  }

  // 3. Viettel-CA
  if (
    code.includes('vt-ca') ||
    code.includes('viettel') ||
    name.includes('viễn thông quân đội') ||
    name.includes('viettel')
  ) {
    return { logo: '/brand/providers/viettel.svg', alt: 'Viettel-CA' };
  }

  // 4. Nacencomm CA2
  if (code.includes('ca2') || code.includes('nacencomm') || name.includes('nacencomm')) {
    return { logo: '/brand/providers/nacencomm.svg', alt: 'Nacencomm CA2' };
  }

  // 5. MISA eSign
  if (code.includes('misa') || name.includes('misa')) {
    return { logo: '/brand/providers/misa-esign.png', alt: 'MISA eSign' };
  }

  // 6. Softdreams EasyCA
  if (
    code.includes('sds') ||
    code.includes('softdreams') ||
    code.includes('easyca') ||
    name.includes('softdreams') ||
    name.includes('easyca')
  ) {
    return { logo: '/brand/providers/easyca.svg', alt: 'Softdreams EasyCA' };
  }

  // 7. VNeID / RAR Test / RSHUB
  if (code.includes('vneid') || name.includes('vneid')) {
    return { logo: '/brand/vneid.svg', alt: 'VNeID SmartCA' };
  }
  if (code.includes('rshub') || code.includes('rartest') || name.includes('rartest') || name.includes('rar test')) {
    return { logo: '/brand/providers/cmc.svg', alt: 'CSign CMC / RAR' };
  }
  if (code.includes('rar') || name.includes('rar')) {
    return { logo: '/brand/vneid.svg', alt: 'Trung tâm RAR' };
  }

  // 8. CMC CSign
  if (code.includes('cmc') || code.includes('csign') || code.includes('cascert') || name.includes('cmc')) {
    return { logo: '/brand/providers/cmc.svg', alt: 'CMC CSign' };
  }

  // 9. BkavCA
  if (code.includes('bkav') || name.includes('bkav')) {
    return { logo: '/brand/providers/bkav.svg', alt: 'BkavCA' };
  }

  // 10. Savis TrustCA
  if (
    code.includes('trustca') ||
    code.includes('savis') ||
    name.includes('trustca') ||
    name.includes('savis')
  ) {
    return { logo: '/brand/providers/trustca.svg', alt: 'TrustCA' };
  }

  // 11. MobiFone
  if (code.includes('mobifone') || name.includes('mobifone')) {
    return { logo: '/brand/providers/mobifone.svg', alt: 'MobiFone' };
  }

  // 12. Mắt Bão
  if (code.includes('matbao') || name.includes('mắt bão') || name.includes('mat bao')) {
    return { logo: '/brand/providers/matbao.svg', alt: 'Mắt Bão CA' };
  }

  // 13. VNPAY
  if (code.includes('vnpay') || name.includes('vnpay')) {
    return { logo: '/brand/providers/vnpay.svg', alt: 'VNPAY-CA' };
  }

  // 14. Hilo
  if (code.includes('hilo') || name.includes('hilo')) {
    return { logo: '/brand/providers/hilo.png', alt: 'Hilo-CA' };
  }

  // 15. IntrustCA
  if (code.includes('intrust') || name.includes('intrust')) {
    return { logo: '/brand/providers/intrustca.png', alt: 'IntrustCA' };
  }

  return null;
}
