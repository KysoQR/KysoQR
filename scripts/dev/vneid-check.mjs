#!/usr/bin/env node
/**
 * Checks the CSign connection for VNeID signing WITHOUT signing anything:
 * login -> refresh-token -> credentials/list for one CCCD. Nothing is sent to
 * anyone's phone (sign-hash is never called).
 *
 *   npm run vneid:check -- <CCCD> [--env <file>]
 *   npm run vneid:check -- --providers [--env <file>]
 *
 * `--providers` lists the certificate providers and their packs (code, name,
 * status, months, price) instead, for the registration of new certificates.
 *
 * Reads CMC_CA_HOST / CMC_CA_USERNAME / CMC_CA_PASSWORD from the environment
 * or the .env file. Prints
 * what is needed to debug the setup -- HTTP results, token lifetimes, and per
 * certificate its credentialID, issuing CA, validity, key and root fingerprint
 * -- but never a token, the password, the CCCD or the certificate holder's name.
 */
import { createHash, X509Certificate } from 'node:crypto';

const TIMEOUT_MS = 15_000;
const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envFile = envFlag >= 0 ? args[envFlag + 1] : '.env';
const providersOnly = args.includes('--providers');
const citizenPid = args.find(
  (arg, index) => !arg.startsWith('--') && (envFlag < 0 || index !== envFlag + 1)
);

try {
  process.loadEnvFile(envFile);
} catch {
  // No such file: rely on the environment.
}

const host = process.env.CMC_CA_HOST?.trim();
const username = process.env.CMC_CA_USERNAME;
const password = process.env.CMC_CA_PASSWORD;

/** Long digit runs (CCCD, phone numbers) are hidden in anything echoed back. */
const redact = (text) =>
  String(text)
    .replace(/[0-9]{8,}/g, '[redacted-number]')
    .slice(0, 300);
const fail = (message) => {
  console.error(`\n[x] ${message}`);
  process.exit(1);
};

if (!host || !username || !password) {
  fail(
    'Thiếu CMC_CA_HOST, CMC_CA_USERNAME hoặc CMC_CA_PASSWORD (trong .env hoặc biến môi trường).'
  );
}
if (!host.startsWith('https://')) fail('CMC_CA_HOST phải bắt đầu bằng https://');
if (!providersOnly && (!citizenPid || !/^[0-9]{12}$/.test(citizenPid))) {
  fail(
    'Cách dùng: npm run vneid:check -- <số CCCD 12 chữ số> [--env <file>]\n' +
      '    hoặc:  npm run vneid:check -- --providers [--env <file>]'
  );
}

const base = host.replace(/[/]+$/, '');

/** A JSON POST, or a GET when `body` is undefined. */
async function post(path, body, token) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error?.name === 'TimeoutError' ? 'không phản hồi sau 15 giây' : 'không kết nối được';
    return { ok: false, status: 0, summary: reason, json: undefined };
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const code = json?.data?.status ?? json?.result?.errorCode ?? json?.error?.code ?? json?.code;
  const message =
    json?.data?.description ?? json?.result?.message ?? json?.error?.message ?? json?.message;
  const summary = [
    `HTTP ${response.status}`,
    `${Math.round(Buffer.byteLength(text) / 1024)} KB`,
    `success=${json?.success}`,
    code !== undefined && code !== null ? `mã ${redact(code)}` : '',
    message ? `"${redact(message)}"` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { ok: response.ok && json?.success === true, status: response.status, summary, json };
}

function minutesLeft(token) {
  try {
    const { exp } = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return typeof exp === 'number'
      ? `${Math.round((exp * 1000 - Date.now()) / 60_000)} phút`
      : 'không rõ';
  } catch {
    return 'không đọc được';
  }
}

console.log(`CSign: ${base}\n`);

// 1. Login
const login = await post('/api/auth/login', { username, password });
console.log(`1. Đăng nhập:        ${login.ok ? 'OK' : 'LỖI'} (${login.summary})`);
if (!login.ok || !login.json?.data?.token)
  fail('Đăng nhập thất bại: kiểm tra CMC_CA_HOST, CMC_CA_USERNAME, CMC_CA_PASSWORD.');
let token = login.json.data.token;
console.log(
  `   token còn:        ${minutesLeft(token)}; refresh token còn: ${minutesLeft(login.json.data.refreshToken)}`
);

// 2. Refresh
const refresh = await post('/api/auth/refresh-token', {
  refreshToken: login.json.data.refreshToken,
});
console.log(`2. Làm mới token:    ${refresh.ok ? 'OK' : 'LỖI'} (${refresh.summary})`);
if (refresh.ok && refresh.json?.data?.token) {
  token = refresh.json.data.token;
  const pairChanged =
    refresh.json.data.refreshToken &&
    refresh.json.data.refreshToken !== login.json.data.refreshToken;
  console.log(
    `   token mới còn:    ${minutesLeft(token)}; trả refresh token mới: ${pairChanged ? 'có' : 'không'}`
  );
}

// 3'. Providers and packs (--providers): nothing personal, nothing sent to a phone.
if (providersOnly) {
  const providers = await post('/api/provider/list', undefined, token);
  console.log(`3. Nhà cung cấp:     ${providers.ok ? 'OK' : 'LỖI'} (${providers.summary})`);
  if (!providers.ok) fail('Không lấy được danh sách nhà cung cấp.');
  for (const provider of providers.json?.data?.providers ?? []) {
    console.log(
      `\n   ${provider.provider} -- ${redact(provider.providerName ?? '?')} (status ${provider.status})`
    );
    for (const pack of provider.servicePackList ?? []) {
      console.log(
        `     - ${pack.servicePackCode}: ${redact(pack.servicePackName ?? '?')}, ` +
          `${pack.servicePackMonth ?? '?'} tháng, giá ${pack.unitPrice ?? '?'}, free ${pack.free ?? '?'}`
      );
    }
  }
  process.exit(0);
}

// 3. Certificates of this CCCD
const list = await post('/api/credentials/list', { citizenPid }, token);
console.log(`3. Chứng thư số:     ${list.ok ? 'OK' : 'LỖI'} (${list.summary})`);
const infos = list.json?.data?.data?.credentialInfos ?? [];
if (!list.ok) fail('Không lấy được danh sách chứng thư.');
if (infos.length === 0)
  fail('CCCD này chưa có chứng thư số đã kích hoạt trên môi trường này (không ký được).');
console.log(`   số chứng thư:     ${infos.length}`);

infos.forEach((info, index) => {
  const cert = info.cert ?? {};
  const key = info.key ?? {};
  console.log(`\n   [${index + 1}] credentialID: ${info.credentialID}`);
  console.log(`       CA cấp:       ${redact(cert.issuerDN ?? '?')}`);
  console.log(
    `       hiệu lực:     ${cert.validFrom ?? '?'} -> ${cert.validTo ?? '?'}; trạng thái ${cert.status ?? '?'}; khoá ${key.status ?? '?'}`
  );
  console.log(`       thuật toán:   ${(key.algo ?? []).join(', ') || '?'}; ${key.len ?? '?'} bit`);
  const chain = (cert.certificates ?? []).map((b64) => {
    try {
      return new X509Certificate(Buffer.from(String(b64).replace(/\s+/g, ''), 'base64'));
    } catch {
      return undefined;
    }
  });
  console.log(
    `       chuỗi:        ${chain.length} chứng thư${chain.some((c) => !c) ? ' (có chứng thư không đọc được)' : ''}`
  );
  const leaf = chain[0];
  if (leaf) {
    const uidMatches = leaf.subject.split('\n').includes(`UID=CCCD:${citizenPid}`);
    const keyInfo = leaf.publicKey.asymmetricKeyDetails;
    console.log(
      `       UID khớp CCCD: ${uidMatches ? 'có' : 'KHÔNG'}; serial khớp credentialID: ${leaf.serialNumber.replace(/^0+/, '').toUpperCase() === String(info.credentialID).replace(/^0+/, '').toUpperCase() ? 'có' : 'KHÔNG'}`
    );
    console.log(
      `       khoá chứng thư: ${leaf.publicKey.asymmetricKeyType} ${keyInfo?.modulusLength ?? ''} bit`
    );
    // Where the certificate says its CA can be fetched (OCSP / CA Issuers URLs).
    const aia = (leaf.infoAccess ?? '').split('\n').filter(Boolean);
    console.log(`       AIA:          ${aia.length > 0 ? aia.join('; ') : 'không có'}`);
  }
  // Every link: is the next certificate really the one that issued and signed
  // this one? (CA names and fingerprints only -- never the signer's name.)
  const cnOf = (dn) => (dn.split('\n').find((line) => line.startsWith('CN=')) ?? 'CN=?').slice(3);
  chain.forEach((current, index) => {
    const next = chain[index + 1];
    if (!current || !next) return;
    let signed = false;
    try {
      signed = current.verify(next.publicKey);
    } catch {
      signed = false;
    }
    const now = Date.now();
    const caValid = now >= Date.parse(next.validFrom) && now <= Date.parse(next.validTo);
    const label = index === 0 ? 'chứng thư người ký' : `CA "${cnOf(current.subject)}"`;
    const sha = createHash('sha256').update(next.raw).digest('hex');
    console.log(
      `       mắt xích ${index}: ${label} (ghi issuer "${cnOf(current.issuer)}") -> "${cnOf(next.subject)}"`
    );
    console.log(
      `         CA kế tiếp: serial ${next.serialNumber}; hiệu lực ${next.validFrom} -> ${next.validTo}; sha256 ${sha}`
    );
    console.log(
      `         là CA: ${next.ca ? 'có' : 'KHÔNG'}; tên khớp: ${current.checkIssued(next) ? 'có' : 'KHÔNG'}; chữ ký khớp: ${signed ? 'có' : 'KHÔNG'}; CA còn hạn: ${caValid ? 'có' : 'KHÔNG'}`
    );
  });
  const last = chain[chain.length - 1];
  if (last) {
    const cn = (last.subject.split('\n').find((line) => line.startsWith('CN=')) ?? 'CN=?').slice(3);
    if (last.checkIssued(last) && last.verify(last.publicKey)) {
      const sha = createHash('sha256').update(last.raw).digest('hex');
      console.log(`       root:         ${cn}`);
      console.log(`       root SHA-256: ${sha}`);
    } else {
      const issuer = (
        last.issuer.split('\n').find((line) => line.startsWith('CN=')) ?? 'CN=?'
      ).slice(3);
      console.log(`       root:         không kèm trong chuỗi (CA cuối do "${issuer}" cấp)`);
    }
  }
});

console.log('\nXong. Không gửi yêu cầu ký nào (sign-hash không được gọi).');
