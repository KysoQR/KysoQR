import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../lib/i18n/init';
import {
  type CasSignerConfigValue,
  isCasSignerConfigValid,
  SignerConfigPanel,
  toggleSignType,
} from './SignerConfigPanel';

const EMPTY: CasSignerConfigValue = {
  signType: null,
  identificationNumber: '',
  taxCode: '',
  organizationName: '',
  representativeName: '',
};
const render = (value: CasSignerConfigValue) =>
  renderToStaticMarkup(createElement(SignerConfigPanel, { value, onChange: () => undefined }));

describe('SignerConfigPanel', () => {
  it('nothing chosen: 2 unpressed buttons, no fields, "the signer chooses" hint', () => {
    const html = render(EMPTY);
    expect(html).toContain('Cá nhân');
    expect(html).toContain('Doanh nghiệp');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('id="signer-cccd"');
    expect(html).not.toContain('id="signer-tax-code"');
    expect(html).toContain('người ký tự chọn ký cá nhân hoặc doanh nghiệp');
  });

  it('PERSONAL: only the CCCD, the "can\'t switch" hint, and the QR hint while the CCCD is empty', () => {
    const html = render({ ...EMPTY, signType: 'PERSONAL' });
    expect(html).toContain('id="signer-cccd"');
    expect(html).not.toContain('id="signer-tax-code"');
    expect(html).toContain('Bắt buộc ký bằng chứng thư cá nhân');
    expect(html).toContain('Để trống thì ký bằng QR.');
    expect(render({ ...EMPTY, signType: 'PERSONAL', identificationNumber: '010101010101' })).not.toContain(
      'Để trống thì ký bằng QR.'
    );
  });

  it('BUSINESS: the CCCD then an optional tax code, with the matching hints', () => {
    const html = render({ ...EMPTY, signType: 'BUSINESS' });
    expect(html).toContain('id="signer-cccd"');
    expect(html).toContain('id="signer-tax-code"');
    expect(html.indexOf('id="signer-tax-code"')).toBeGreaterThan(html.indexOf('id="signer-cccd"'));
    expect(html).not.toContain('Không bắt buộc');
    expect(html).toContain('Bắt buộc ký bằng chứng thư doanh nghiệp');
    expect(html).toContain('bất kỳ doanh nghiệp nào');
    expect(render({ ...EMPTY, signType: 'BUSINESS', taxCode: '0101010101' })).toContain(
      'doanh nghiệp có MST 0101010101'
    );
  });

  it('CCCD note: shown with either sign type, not before one is chosen, replaced by the error', () => {
    const NOTE = 'Nhập CCCD để nhận thông báo ký trên Cas ID';
    expect(render(EMPTY)).not.toContain(NOTE);
    expect(render({ ...EMPTY, signType: 'PERSONAL' })).toContain(NOTE);
    expect(render({ ...EMPTY, signType: 'BUSINESS' })).toContain(NOTE);
    const malformed = render({ ...EMPTY, signType: 'PERSONAL', identificationNumber: '123' });
    expect(malformed).toContain('CCCD phải là 12 số');
    expect(malformed).not.toContain(NOTE);
  });

  it('flags a malformed CCCD and a malformed tax code', () => {
    expect(render({ ...EMPTY, signType: 'PERSONAL', identificationNumber: '123' })).toContain('CCCD phải là 12 số');
    expect(render({ ...EMPTY, signType: 'BUSINESS', taxCode: '123' })).toContain('Mã số thuế phải là 10 số');
  });

  it('toggleSignType: pick, switch, and press again to clear -- typed values survive', () => {
    const typed: CasSignerConfigValue = { ...EMPTY, identificationNumber: '010101010101', taxCode: '0101010101' };
    const business = toggleSignType(typed, 'BUSINESS');
    expect(business.signType).toBe('BUSINESS');
    const personal = toggleSignType(business, 'PERSONAL');
    expect(personal).toEqual({ ...typed, signType: 'PERSONAL' });
    expect(toggleSignType(personal, 'BUSINESS').taxCode).toBe('0101010101');
    expect(toggleSignType(personal, 'PERSONAL').signType).toBeNull();
  });
});

describe('isCasSignerConfigValid', () => {
  it('nothing is required, whatever the sign type', () => {
    expect(isCasSignerConfigValid(EMPTY)).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'PERSONAL' })).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'BUSINESS' })).toBe(true);
  });

  it('a CCCD that is present must be well formed (9 or 12 digits)', () => {
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'PERSONAL', identificationNumber: '010101010101' })).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'BUSINESS', identificationNumber: '079123456' })).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'PERSONAL', identificationNumber: '123' })).toBe(false);
  });

  it('BUSINESS: a tax code that is present must be well formed', () => {
    const business: CasSignerConfigValue = { ...EMPTY, signType: 'BUSINESS' };
    expect(isCasSignerConfigValid({ ...business, taxCode: '0101010101' })).toBe(true);
    expect(isCasSignerConfigValid({ ...business, taxCode: ' 0101010101-001 ' })).toBe(true);
    expect(isCasSignerConfigValid({ ...business, taxCode: '   ' })).toBe(true);
    expect(isCasSignerConfigValid({ ...business, taxCode: '123' })).toBe(false);
  });

  it('hidden fields never block: a stale tax code with PERSONAL, anything with no sign type', () => {
    expect(isCasSignerConfigValid({ ...EMPTY, signType: 'PERSONAL', taxCode: '123' })).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, identificationNumber: '123', taxCode: '123' })).toBe(true);
  });
});
