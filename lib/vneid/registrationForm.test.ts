import { describe, expect, it } from 'vitest';
import { checkRegistrationForm, EMPTY_REGISTRATION_FORM } from './registrationForm';

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const VALID = {
  ...EMPTY_REGISTRATION_FORM,
  fullName: '  Nguyễn   Văn A ',
  birthDate: '1990-12-23',
  gender: 'Nam',
  phone: '+84 912.345.678',
  email: 'a@example.test',
  dateOfIssue: '2021-01-01',
  idCardExpireDate: '2030-12-23',
};

describe('checkRegistrationForm', () => {
  it('turns a valid form into CSign userInfo: clean text, dd/MM/yyyy dates, no empty fields', () => {
    expect(checkRegistrationForm(VALID, NOW)).toEqual({
      ok: true,
      userInfo: {
        fullName: 'Nguyễn Văn A',
        birthDate: '23/12/1990',
        gender: 'Nam',
        phone: '+84912345678',
        email: 'a@example.test',
        nationalityCode: 'VN',
        dateOfIssue: '01/01/2021',
        idCardExpireDate: '23/12/2030',
      },
    });
  });

  it('names each field that is missing or wrong', () => {
    const result = checkRegistrationForm(
      {
        ...VALID,
        fullName: 'A1',
        birthDate: '2026-11-06',
        gender: 'X',
        phone: '12345',
        email: 'a@b',
        nationalityCode: 'Viet',
        dateOfIssue: '2021-02-30',
        permanentAddress: 'x'.repeat(251),
      },
      NOW
    );
    expect(result).toEqual({
      ok: false,
      problems: {
        fullName: 'invalid',
        birthDate: 'invalid',
        gender: 'invalid',
        phone: 'invalid',
        email: 'invalid',
        nationalityCode: 'tooLong',
        dateOfIssue: 'invalid',
        permanentAddress: 'tooLong',
      },
    });
    expect(checkRegistrationForm({}, NOW)).toEqual({
      ok: false,
      problems: {
        fullName: 'required',
        birthDate: 'required',
        gender: 'required',
        phone: 'required',
        email: 'required',
      },
    });
  });

  it('checks the dates against each other and refuses non-text values', () => {
    expect(checkRegistrationForm({ ...VALID, dateOfIssue: '1989-01-01' }, NOW)).toMatchObject({
      problems: { dateOfIssue: 'invalid' },
    });
    expect(checkRegistrationForm({ ...VALID, idCardExpireDate: '2020-01-01' }, NOW)).toMatchObject({
      problems: { idCardExpireDate: 'invalid' },
    });
    expect(checkRegistrationForm({ ...VALID, email: ['a@example.test'] }, NOW)).toMatchObject({
      problems: { email: 'invalid' },
    });
  });

  it('drops invisible and direction-changing characters from what is sent', () => {
    const override = String.fromCharCode(0x202e);
    const result = checkRegistrationForm({ ...VALID, permanentCityText: `Hà${override} Nội` }, NOW);
    expect(result.ok && result.userInfo.permanentCityText).toBe('Hà Nội');
  });
});
