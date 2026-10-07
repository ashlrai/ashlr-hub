/** Published personal-plan equivalence, not invoice pricing or actual attributed spend. */
import { formatDecimalMetric } from '../../../components/charts/format-metric.js';
export const CODEX_CREDIT_VALUE_SOURCE = 'https://developers.openai.com/community/students';
export const CODEX_CREDIT_VALUE_CHECKED = '2026-10-01';

function decimalBalance(balance: unknown): { units: bigint; denominator: bigint } | null {
  if (typeof balance !== 'string' || balance.length > 64 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(balance)) return null;
  const [whole, fraction = ''] = balance.split('.');
  return { units: BigInt(whole! + fraction), denominator: 10n ** BigInt(fraction.length) };
}

/** Display only: preserve the raw reading elsewhere; never round evidence or quota. */
export function formatNativeCreditUnits(balance: unknown): string | null {
  return decimalBalance(balance) === null ? null : formatDecimalMetric(balance);
}

export function estimatedCreditValue(balance: unknown, plan: string | null): string | null {
  if (!['free', 'go', 'plus', 'pro'].includes(plan ?? '')) return null;
  const parsed = decimalBalance(balance);
  if (parsed === null) return null;
  const { units, denominator } = parsed;
  // Four cents/credit; round only once for display, never the original balance.
  const places = denominator.toString().length + 1;
  const digits = (units * 4n).toString().padStart(places + 1, '0');
  return `$${formatDecimalMetric(`${digits.slice(0, -places)}.${digits.slice(-places)}`)}`;
}
