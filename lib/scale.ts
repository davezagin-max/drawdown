/** The little bit of chart math the SVG panels share. */

export type Scale = (value: number) => number;

export function linear(domain: [number, number], range: [number, number]): Scale {
  const span = domain[1] - domain[0] || 1;
  return (value) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

/** Round tick values covering [min, max], about `target` of them. */
export function ticks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const rough = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const first = Math.ceil(min / step - 1e-9) * step;
  const out: number[] = [];
  for (let value = first; value <= max + step * 1e-9; value += step) {
    out.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return out;
}

/** Index of the value in a sorted array closest to `target`. */
export function nearest(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < target) low = mid;
    else high = mid;
  }
  return Math.abs(sorted[low] - target) <= Math.abs(sorted[high] - target) ? low : high;
}

/** "M x,y L x,y ..." through the points. */
export function path(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const clean = hex.trim().replace("#", "");
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Position `t` in [0, 1] along a ramp of evenly spaced color stops. */
export function ramp(stops: Rgb[], t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(clamped));
  const local = clamped - index;
  const [a, b] = [stops[index], stops[index + 1]];
  return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * local) as Rgb;
}
