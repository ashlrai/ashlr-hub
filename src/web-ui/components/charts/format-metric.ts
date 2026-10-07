/** Display precision only. Source readings and control decisions retain exact values. */
const metric = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 });

export function formatMetric(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? metric.format(value) : '—';
}

export function formatMetricUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '-' : ''}$${formatMetric(Math.abs(value))}`;
}

/** Native balances may exceed safe integers: round decimal digits without Number coercion. */
export function formatDecimalMetric(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole! + fraction);
  if (units === 0n) return '0';
  const cut = Math.max(0, units.toString().length - 2);
  const quantum = 10n ** BigInt(cut);
  const rounded = ((units + quantum / 2n) / quantum).toString();
  const places = fraction.length - cut;
  const digits = places > 0 ? rounded.padStart(places + 1, '0') : rounded + '0'.repeat(-places);
  const integer = (places > 0 ? digits.slice(0, -places) : digits).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const decimals = places > 0 ? digits.slice(-places).replace(/0+$/u, '') : '';
  return integer + (decimals ? `.${decimals}` : '');
}
