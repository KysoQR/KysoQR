import { constants, verify, X509Certificate } from 'node:crypto';
import { PdfSignError } from './errors.ts';

/**
 * RSA checks done with node:crypto (OpenSSL), not with node-forge: this is the
 * check that decides whether a signature CSign handed back is the real thing,
 * so it uses the platform implementation.
 */

export function loadCertificate(der: Uint8Array): X509Certificate {
  try {
    return new X509Certificate(Buffer.from(der));
  } catch {
    throw new PdfSignError('CMS_INVALID', 'certificate is not a valid X.509 DER');
  }
}

/** Modulus size in bytes, or undefined when the key is not RSA. */
export function rsaModulusBytes(certificate: X509Certificate): number | undefined {
  const key = certificate.publicKey;
  if (key.asymmetricKeyType !== 'rsa') return undefined;
  const bits = key.asymmetricKeyDetails?.modulusLength;
  return bits ? Math.ceil(bits / 8) : undefined;
}

/**
 * RSASSA-PKCS1-v1_5 with SHA-256 over `data` -- equivalently, a signature over
 * DigestInfo(sha256, SHA-256(data)). That is what a signer that is handed the
 * 32-byte digest of the signed attributes and wraps it in DigestInfo produces.
 */
export function verifyRsaPkcs1Sha256(
  certificate: X509Certificate,
  data: Uint8Array,
  signature: Uint8Array
): boolean {
  const modulusBytes = rsaModulusBytes(certificate);
  if (!modulusBytes || signature.length !== modulusBytes) return false;
  try {
    return verify(
      'sha256',
      data,
      { key: certificate.publicKey, padding: constants.RSA_PKCS1_PADDING },
      signature
    );
  } catch {
    return false;
  }
}
