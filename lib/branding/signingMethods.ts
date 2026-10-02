/**
 * Signing methods and signature providers shown in the landing page's Casso
 * branding section (components/home/SigningMethodsSection.tsx).
 *
 * Only `casid` is actually usable on KysoQR today -- the other two are shown
 * as "in development". Adding or removing a provider only means editing this
 * file. Logo files live in public/brand/ (sources: public/brand/SOURCES.md);
 * replacing a logo keeps the same file name so nothing here changes.
 */

export type SigningMethodKey = 'casid' | 'vneid' | 'usbtoken';

export interface SignatureProvider {
  /** Brand name, used as the logo's alt text. */
  name: string;
  logo: string;
  /** Small label under the logo when the logo alone doesn't name the service. */
  caption?: string;
}

export interface SigningMethod {
  key: SigningMethodKey;
  logo: string;
  available: boolean;
  providers: SignatureProvider[];
}

export const CASSO_HOMEPAGE_URL = 'https://casso.vn/';

/** Free CAS ID digital-signature registration guide, linked from the CAS ID card. */
export const CAS_ID_REGISTER_URL = 'https://cas.so/cas-id/chu-ky-so/';

/**
 * "Hướng dẫn đăng ký chứng thư số Cas Cert trên App Cas ID" on YouTube
 * (https://youtu.be/OLVWXfumxoM), embedded in step 2 of the signing wizard.
 * Uses the privacy-enhanced youtube-nocookie.com host; `rel=0` keeps the
 * end-screen suggestions to the same channel.
 */
export const CAS_ID_GUIDE_VIDEO_EMBED_URL =
  'https://www.youtube-nocookie.com/embed/OLVWXfumxoM?rel=0';

export const SIGNING_METHODS: SigningMethod[] = [
  {
    key: 'casid',
    logo: '/brand/cas-id.png',
    available: true,
    providers: [
      { name: 'IntrustCA', logo: '/brand/providers/intrustca.png' },
      { name: 'CAS CERT by CMC CA', logo: '/brand/providers/cascert-cmc.png' },
      { name: 'Hilo-CA', logo: '/brand/providers/hilo.png' },
    ],
  },
  {
    key: 'vneid',
    logo: '/brand/vneid.svg',
    available: false,
    providers: [
      { name: 'VNPT SmartCA', logo: '/brand/providers/vnpt-smartca.svg' },
      { name: 'Viettel MySign', logo: '/brand/providers/viettel.svg', caption: 'MySign' },
      { name: 'MISA eSign', logo: '/brand/providers/misa-esign.png' },
    ],
  },
  {
    key: 'usbtoken',
    logo: '/brand/usb-token.png',
    available: false,
    providers: [
      { name: 'Viettel-CA', logo: '/brand/providers/viettel.svg', caption: 'Viettel-CA' },
      { name: 'VNPT-CA', logo: '/brand/providers/vnpt-ca.png' },
      { name: 'BKAV-CA', logo: '/brand/providers/bkav.svg', caption: 'BKAV-CA' },
    ],
  },
];
