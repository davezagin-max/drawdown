/**
 * Turns the frontier payload into what a renderer needs: positions scaled into a
 * unit box, a 0..1 Sharpe value per point for color, and the three highlighted mixes.
 * Pure, so the 3D view, the 2D fallback, and the tests share one definition.
 */
import type { Frontier, FrontierPoint } from "./schema";

export type HighlightKey = "current" | "maxSharpe" | "minVolatility";

export interface Highlight {
  key: HighlightKey;
  label: string;
  point: FrontierPoint;
  /** Index into the cloud arrays (highlights are appended after the simulated mixes). */
  index: number;
}

export interface Axis {
  min: number;
  max: number;
}

export interface Cloud {
  /** Number of points, simulated mixes first, then the highlights. */
  size: number;
  /** x = volatility, y = annual return, z = max drawdown, each scaled to [-1, 1]. */
  positions: Float32Array;
  /**
   * Sharpe ratio scaled to [0, 1] for color. The scale runs between the 2nd and 98th
   * percentile (see `sharpe`), so a few extreme mixes do not flatten everyone else
   * into one shade; values beyond it are clamped.
   */
  shade: Float32Array;
  /** The raw [volatility, return, Sharpe, drawdown] for a point index. */
  raw: (index: number) => [number, number, number, number];
  volatility: Axis;
  annualReturn: Axis;
  maxDrawdown: Axis;
  sharpe: Axis;
  highlights: Highlight[];
}

const LABELS: Record<HighlightKey, string> = {
  current: "This portfolio",
  maxSharpe: "Best Sharpe",
  minVolatility: "Lowest volatility",
};

function extent(values: number[]): Axis {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === max ? { min: min - 0.5, max: max + 0.5 } : { min, max };
}

const unit = (value: number, axis: Axis) => ((value - axis.min) / (axis.max - axis.min)) * 2 - 1;

/** The range that holds the middle of the values: [2nd percentile, 98th percentile]. */
function robustExtent(values: number[]): Axis {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.round(q * (sorted.length - 1))];
  const [min, max] = [at(0.02), at(0.98)];
  return max > min ? { min, max } : extent(values);
}

export function buildCloud(frontier: Frontier): Cloud {
  const keys: HighlightKey[] = ["current", "maxSharpe", "minVolatility"];
  const rows: [number, number, number, number][] = [
    ...frontier.points,
    ...keys.map((key): [number, number, number, number] => {
      const p = frontier[key];
      return [p.volatility, p.annualReturn, p.sharpe, p.maxDrawdown];
    }),
  ];
  const volatility = extent(rows.map((r) => r[0]));
  const annualReturn = extent(rows.map((r) => r[1]));
  const sharpe = robustExtent(rows.map((r) => r[2]));
  const maxDrawdown = extent(rows.map((r) => r[3]));

  const positions = new Float32Array(rows.length * 3);
  const shade = new Float32Array(rows.length);
  rows.forEach((row, i) => {
    positions[i * 3] = unit(row[0], volatility);
    positions[i * 3 + 1] = unit(row[1], annualReturn);
    positions[i * 3 + 2] = unit(row[3], maxDrawdown);
    shade[i] = Math.min(1, Math.max(0, (row[2] - sharpe.min) / (sharpe.max - sharpe.min)));
  });

  return {
    size: rows.length,
    positions,
    shade,
    raw: (index) => rows[index],
    volatility,
    annualReturn,
    maxDrawdown,
    sharpe,
    highlights: keys.map((key, offset) => ({
      key,
      label: LABELS[key],
      point: frontier[key],
      index: frontier.points.length + offset,
    })),
  };
}
