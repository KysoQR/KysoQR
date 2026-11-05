import { sanitizeDisplayText } from '../pdfSign/text';

/**
 * The certificate registration form (CSign credentials/register, userInfo),
 * checked the same way in the browser -- to show what is wrong under each
 * field -- and on the server, which trusts nothing the browser says. Pure:
 * no server code, no I/O.
 *
 * Every field CSign accepts is here; CSign itself only requires the CCCD (the
 * rest comes from VNeID once the citizen agrees to share it), so only the
 * fields a person can be asked for without their card in hand are required.
 */

export const REGISTRATION_FIELDS = [
  'fullName',
  'birthDate',
  'gender',
  'phone',
  'email',
  'nationalityCode',
  'issuingAuthority',
  'dateOfIssue',
  'idCardExpireDate',
  'permanentAddress',
  'permanentVillageText',
  'permanentCityText',
  'livingPlaceAddress',
  'livingPlaceVillageText',
  'livingPlaceCityText',
] as const;

export type RegistrationField = (typeof REGISTRATION_FIELDS)[number];
/** Dates as `YYYY-MM-DD` (what <input type="date"> gives), everything else as typed. */
export type RegistrationForm = Record<RegistrationField, string>;
export type FieldProblem = 'required' | 'invalid' | 'tooLong';
export const GENDERS = ['Nam', 'Nữ'] as const;

export const REQUIRED_FIELDS: ReadonlySet<RegistrationField> = new Set([
  'fullName',
  'birthDate',
  'gender',
  'phone',
  'email',
]);

const MAX_CHARS: Record<RegistrationField, number> = {
  fullName: 100,
  birthDate: 10,
  gender: 3,
  phone: 20,
  email: 254,
  nationalityCode: 2,
  issuingAuthority: 200,
  dateOfIssue: 10,
  idCardExpireDate: 10,
  permanentAddress: 250,
  permanentVillageText: 100,
  permanentCityText: 100,
  livingPlaceAddress: 250,
  livingPlaceVillageText: 100,
  livingPlaceCityText: 100,
};

const DATE_FIELDS = new Set<RegistrationField>(['birthDate', 'dateOfIssue', 'idCardExpireDate']);

export const EMPTY_REGISTRATION_FORM: RegistrationForm = Object.fromEntries(
  REGISTRATION_FIELDS.map((field) => [field, field === 'nationalityCode' ? 'VN' : ''])
) as RegistrationForm;

/** userInfo as CSign wants it (dates as dd/MM/yyyy), without the CCCD. */
export type RegistrationUserInfoFields = Partial<Record<RegistrationField, string>>;

export type RegistrationCheck =
  | { ok: true; userInfo: RegistrationUserInfoFields }
  | { ok: false; problems: Partial<Record<RegistrationField, FieldProblem>> };

/** `YYYY-MM-DD` of a real calendar day, or undefined. */
function isoDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : undefined;
}

const toCsignDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Today in Vietnam (UTC+7), as `YYYY-MM-DD`. */
const vietnamToday = (nowMs: number) =>
  new Date(nowMs + 7 * 60 * 60_000).toISOString().slice(0, 10);

const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;
const PHONE = /^(0|\+84)[0-9]{9,10}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** `nowMs` decides what "today" is for the dates (the server passes its clock). */
export function checkRegistrationForm(input: unknown, nowMs = Date.now()): RegistrationCheck {
  const source =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const problems: Partial<Record<RegistrationField, FieldProblem>> = {};
  const values: Partial<Record<RegistrationField, string>> = {};

  for (const field of REGISTRATION_FIELDS) {
    const raw = source[field];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      problems[field] = 'invalid';
      continue;
    }
    const text = typeof raw === 'string' ? raw : '';
    if (text.length > MAX_CHARS[field] * 4) {
      problems[field] = 'tooLong';
      continue;
    }
    const clean = sanitizeDisplayText(text, MAX_CHARS[field] + 1);
    if (clean.length > MAX_CHARS[field]) problems[field] = 'tooLong';
    else if (clean === '') {
      if (REQUIRED_FIELDS.has(field)) problems[field] = 'required';
    } else values[field] = clean;
  }

  const today = vietnamToday(nowMs);
  const check = (field: RegistrationField, valid: (value: string) => boolean) => {
    const value = values[field];
    if (value !== undefined && !problems[field] && !valid(value)) problems[field] = 'invalid';
  };
  if (values.phone !== undefined) values.phone = values.phone.replace(/[\s.()-]/g, '');
  if (values.nationalityCode !== undefined)
    values.nationalityCode = values.nationalityCode.toUpperCase();
  check('fullName', (value) => NAME.test(value));
  check('gender', (value) => (GENDERS as readonly string[]).includes(value));
  check('phone', (value) => PHONE.test(value));
  check('email', (value) => EMAIL.test(value));
  check('nationalityCode', (value) => /^[A-Z]{2}$/.test(value));
  for (const field of DATE_FIELDS) check(field, (value) => isoDate(value) !== undefined);
  check('birthDate', (value) => value >= '1900-01-01' && value <= today);
  check(
    'dateOfIssue',
    (value) => value <= today && (!values.birthDate || value >= values.birthDate)
  );
  check('idCardExpireDate', (value) => !values.dateOfIssue || value > values.dateOfIssue);

  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const userInfo: RegistrationUserInfoFields = {};
  for (const field of REGISTRATION_FIELDS) {
    const value = values[field];
    if (value !== undefined) userInfo[field] = DATE_FIELDS.has(field) ? toCsignDate(value) : value;
  }
  return { ok: true, userInfo };
}
