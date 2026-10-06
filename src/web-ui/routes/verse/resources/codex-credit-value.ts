/** Published personal-plan equivalence, not invoice pricing or actual attributed spend. */
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
  const parsed = decimalBalance(balance);
  if (parsed === null) return null;
  const { units, denominator } = parsed;
  if (units > 0n && units * 100n < denominator) return '<0.01';
  const hundredths = (units * 100n + denominator / 2n) / denominator;
  const whole = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return whole + (fraction ? `.${fraction}` : '');
}

export function estimatedCreditValue(balance: unknown, plan: string | null): string | null {
  if (!['free', 'go', 'plus', 'pro'].includes(plan ?? '')) return null;
  const parsed = decimalBalance(balance);
  if (parsed === null) return null;
  const { units, denominator } = parsed;
  // 2500 credits = $100: four cents/credit, rounded only at the displayed cent.
  const cents = (units * 4n + denominator / 2n) / denominator;
  return `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
