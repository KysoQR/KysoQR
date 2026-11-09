'use client';

import { useState } from 'react';
import {
  checkRegistrationForm,
  copyPermanentToLiving,
  EMPTY_REGISTRATION_FORM,
  type FieldProblem,
  type RegistrationField,
  type RegistrationForm,
} from '../registrationForm';

export type RegistrationProblems = Partial<Record<RegistrationField, FieldProblem>>;

/**
 * The certificate registration form as typed, shared by the VNeID page and the
 * register popup: the fields, "living place = permanent address", consent and
 * the problems found by the same check the server runs. In memory only:
 * nothing of it is stored in the browser.
 */
export function useRegistrationForm() {
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION_FORM);
  const [sameAddress, setSameAddress] = useState(false);
  const [consent, setConsent] = useState(false);
  const [problems, setProblems] = useState<RegistrationProblems>({});

  const setField = (field: RegistrationField, value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      return sameAddress ? copyPermanentToLiving(next) : next;
    });
    setProblems((current) => ({ ...current, [field]: undefined }));
  };

  const toggleSameAddress = (checked: boolean) => {
    setSameAddress(checked);
    if (checked) setForm(copyPermanentToLiving);
  };

  /** Runs the shared check and shows what is wrong; true when the form can be sent. */
  const validate = () => {
    const checked = checkRegistrationForm(form);
    setProblems(checked.ok ? {} : checked.problems);
    return checked.ok;
  };

  /** What the person typed, empty fields left out (dates as YYYY-MM-DD); the
   * server checks and converts it again. */
  const userInfo = () =>
    Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim()));

  return {
    form,
    sameAddress,
    consent,
    setConsent,
    problems,
    hasProblems: Object.values(problems).some(Boolean),
    setField,
    toggleSameAddress,
    validate,
    userInfo,
  };
}

export type RegistrationFormState = ReturnType<typeof useRegistrationForm>;
