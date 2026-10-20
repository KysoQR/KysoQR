export const OTEL_ALIAS_NEEDLE: string;
export const OTEL_ALIAS_REPLACEMENT: string;
export function patchOpenNextOtelAlias(source: string): { source: string; changed: boolean };
