import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import '../lib/i18n/init';
import {
  type CasSignerConfigValue,
  isCasSignerConfigValid,
  SignerConfigPanel,
  switchSignerKind,
} from './SignerConfigPanel';

const EMPTY: CasSignerConfigValue = {
  signerKind: 'individual',
  identificationNumber: '',
  taxCode: '',
  organizationName: '',
  representativeName: '',
};
const render = (value: CasSignerConfigValue) =>
  renderToStaticMarkup(createElement(SignerConfigPanel, { value, onChange: () => undefined }));

/** CSS classes of the <p> that holds `text` (the one-line notice under the kind switch). */
const classesOfParagraphWith = (html: string, text: string) =>
  new RegExp(`<p class="([^"]*)">(?:(?!</p>).)*?${text}`, 's').exec(html)?.[1] ?? '';

describe('SignerConfigPanel', () => {
  it('enterprise: asks for the tax code and the CCCD (so Cas ID can notify the signer), with no "leave blank to sign by QR" hint', () => {
    const html = render({ ...EMPTY, signerKind: 'enterprise' });
    expect(html).toContain('id="signer-tax-code"');
    expect(html).toContain('id="signer-cccd"');
    expect(html).toContain('CCCD người ký');
    // CCCD sits below the tax code
    expect(html.indexOf('id="signer-cccd"')).toBeGreaterThan(html.indexOf('id="signer-tax-code"'));
    // The QR-only hint is for individuals; an enterprise never sees it, empty CCCD or not
    expect(html).not.toContain('Để trống thì ký bằng QR.');
    expect(render({ ...EMPTY, signerKind: 'enterprise', identificationNumber: '077088002778' })).not.toContain(
      'Để trống thì ký bằng QR.'
    );
  });

  it('enterprise: a malformed CCCD is flagged', () => {
    expect(render({ ...EMPTY, signerKind: 'enterprise', identificationNumber: '123' })).toContain(
      'CCCD phải là 12 số'
    );
  });

  it('individual: only the CCCD, with the QR hint while it is empty and none once typed', () => {
    const html = render(EMPTY);
    expect(html).toContain('id="signer-cccd"');
    expect(html).not.toContain('id="signer-tax-code"');
    expect(html).toContain('Để trống thì ký bằng QR.');
    expect(render({ ...EMPTY, identificationNumber: '077088002778' })).not.toContain('Để trống thì ký bằng QR.');
  });

  it('notice colour: red for the mandatory tax code (enterprise), green for the individual hint', () => {
    expect(classesOfParagraphWith(render({ ...EMPTY, signerKind: 'enterprise' }), 'Bắt buộc nhập MST')).toContain(
      'text-error-text'
    );
    const individual = classesOfParagraphWith(render(EMPTY), 'Nhập thông tin thì gửi yêu cầu ký');
    expect(individual).toContain('text-primary-strong');
    expect(individual).not.toContain('text-error-text');
  });

  it('switching the signer kind keeps the CCCD and clears everything else', () => {
    const typed: CasSignerConfigValue = {
      signerKind: 'enterprise',
      identificationNumber: '077088002778',
      taxCode: '0316794479',
      organizationName: 'CASSO',
      representativeName: 'A',
    };
    expect(switchSignerKind(typed, 'individual')).toEqual({
      signerKind: 'individual',
      identificationNumber: '077088002778',
      taxCode: '',
      organizationName: '',
      representativeName: '',
    });
    expect(switchSignerKind(switchSignerKind(typed, 'individual'), 'enterprise').identificationNumber).toBe(
      '077088002778'
    );
  });

  it('form validity: an enterprise needs BOTH a well-formed tax code and a well-formed CCCD ("Ký" stays off otherwise)', () => {
    const enterprise: CasSignerConfigValue = { ...EMPTY, signerKind: 'enterprise' };
    const MST = '0316794479';
    const CCCD = '077088002778';
    // missing one or both
    expect(isCasSignerConfigValid(enterprise)).toBe(false);
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: MST })).toBe(false); // MST only
    expect(isCasSignerConfigValid({ ...enterprise, identificationNumber: CCCD })).toBe(false); // CCCD only
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: MST, identificationNumber: '   ' })).toBe(false); // blank CCCD
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: '   ', identificationNumber: CCCD })).toBe(false); // blank MST
    // both present -> valid, also with a branch suffix and an old 9-digit CMND
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: MST, identificationNumber: CCCD })).toBe(true);
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: '0316794479-001', identificationNumber: '079123456' })).toBe(
      true
    );
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: ` ${MST} `, identificationNumber: ` ${CCCD} ` })).toBe(true);
    // both present but one malformed
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: MST, identificationNumber: '123' })).toBe(false);
    expect(isCasSignerConfigValid({ ...enterprise, taxCode: '123', identificationNumber: CCCD })).toBe(false);
  });

  it('form validity: an individual still needs nothing, only a CCCD that is present must be well formed', () => {
    expect(isCasSignerConfigValid(EMPTY)).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, identificationNumber: '077088002778' })).toBe(true);
    expect(isCasSignerConfigValid({ ...EMPTY, identificationNumber: '123' })).toBe(false);
  });
});
