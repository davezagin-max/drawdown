/** Number formatting for the dashboard. One place, so every panel rounds the same way. */

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("en-US");
const dayFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A fraction as a percentage: 0.1834 -> "18.3%". U+2212 minus for negatives. */
export function pct(value: number, decimals = 1): string {
  const text = `${Math.abs(value * 100).toFixed(decimals)}%`;
  return value < 0 && Number(text.slice(0, -1)) !== 0 ? `−${text}` : text;
}

/** Always signed, for changes: "+3.2%" / "−3.2%". */
export function signedPct(value: number, decimals = 1): string {
  const text = pct(value, decimals);
  return value > 0 && !text.startsWith("−") && Number(text.slice(0, -1)) !== 0 ? `+${text}` : text;
}

export function num(value: number, decimals = 2): string {
  const text = Math.abs(value).toFixed(decimals);
  return value < 0 && Number(text) !== 0 ? `−${text}` : text;
}

export function usd(value: number): string {
  return usdFormat.format(value).replace("-", "−");
}

export function count(value: number): string {
  return integer.format(value);
}

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** "2022-08-04" -> "Aug 4, 2022" */
export function day(iso: string): string {
  return dayFormat.format(parse(iso));
}

/** "2022-08-04" -> "Aug 2022" */
export function month(iso: string): string {
  return monthFormat.format(parse(iso));
}
