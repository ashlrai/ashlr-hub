/** Published personal-plan equivalence, not invoice pricing or actual attributed spend. */
export const CODEX_CREDIT_VALUE_SOURCE = 'https://developers.openai.com/community/students';
export const CODEX_CREDIT_VALUE_CHECKED = '2026-10-01';
export function estimatedCreditValue(balance: unknown, plan: string | null): string | null {
  if (!['free', 'go', 'plus', 'pro'].includes(plan ?? '') || typeof balance !== 'string' || balance.length > 64 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(balance)) return null;
  const [whole, fraction = ''] = balance.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  // 2500 credits = $100: four cents/credit, rounded only at the displayed cent.
  const cents = (BigInt(whole! + fraction) * 4n + denominator / 2n) / denominator;
  return `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
