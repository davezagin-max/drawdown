"use client";

import { useMemo, useRef } from "react";
import { count, pct, signedPct } from "@/lib/format";
import { linear, path, ticks } from "@/lib/scale";
import type { Analysis } from "@/lib/schema";
import { useWidth } from "../hooks";

const MARGIN = { left: 40, right: 84, top: 8, bottom: 20 };
const HEIGHT = 190;

/**
 * Where a year of resampled history could leave the portfolio: the middle half of the
 * simulated paths in the darker band, nine tenths of them in the lighter one.
 */
export function MonteCarloFan({ analysis }: { analysis: Analysis }) {
  const simulation = analysis.monteCarlo;
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap, 420);

  const model = useMemo(() => {
    const { bands, bandDays, horizonDays } = simulation;
    const low = Math.min(0, ...bands.p5);
    const high = Math.max(...bands.p95);
    const x = linear([0, horizonDays], [MARGIN.left, width - MARGIN.right]);
    const y = linear([low * 1.05, high * 1.05], [HEIGHT - MARGIN.bottom, MARGIN.top]);
    // Every path starts at zero on day zero.
    const days = [0, ...bandDays];
    const line = (values: number[]) =>
      [0, ...values].map((value, i): [number, number] => [x(days[i]), y(value)]);
    const band = (upper: number[], lower: number[]) =>
      `${path(line(upper))}L${[...line(lower)]
        .reverse()
        .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`)
        .join("L")}Z`;
    const quarter = horizonDays / 4;
    return {
      x,
      y,
      outer: band(bands.p95, bands.p5),
      inner: band(bands.p75, bands.p25),
      median: path(line(bands.p50)),
      yTicks: ticks(low, high, 4),
      xTicks: [1, 2, 3, 4].map((q) => ({
        x: x(q * quarter),
        label: `${Math.round(q * quarter)}d`,
      })),
    };
  }, [simulation, width]);

  const ends = [
    { key: "p95", label: "95th", value: simulation.percentiles.p95 },
    { key: "p50", label: "median", value: simulation.percentiles.p50 },
    { key: "p5", label: "5th", value: simulation.percentiles.p5 },
  ];

  return (
    <div>
      <div ref={wrap}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-full"
          role="img"
          aria-label={`Simulated one-year outcomes. Median ${signedPct(simulation.percentiles.p50)}, 5th percentile ${signedPct(simulation.percentiles.p5)}, 95th percentile ${signedPct(simulation.percentiles.p95)}.`}
        >
          {model.yTicks.map((value) => (
            <g key={value}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={model.y(value)}
                y2={model.y(value)}
                stroke={value === 0 ? "var(--axis)" : "var(--grid)"}
              />
              <text
                x={MARGIN.left - 6}
                y={model.y(value) + 3.5}
                textAnchor="end"
                className="fill-muted font-mono text-[10px]"
              >
                {signedPct(value, 0)}
              </text>
            </g>
          ))}
          <path d={model.outer} fill="var(--series-1)" fillOpacity={0.13} />
          <path d={model.inner} fill="var(--series-1)" fillOpacity={0.22} />
          <path
            d={model.median}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {ends.map((end) => (
            <text
              key={end.key}
              x={width - MARGIN.right + 6}
              y={model.y(end.value) + 3.5}
              className="font-mono text-[10px]"
            >
              <tspan className="fill-fg">{signedPct(end.value, 0)}</tspan>
              <tspan className="fill-muted"> {end.label}</tspan>
            </text>
          ))}
          {model.xTicks.map((tick) => (
            <text
              key={tick.label}
              x={tick.x}
              y={HEIGHT - 5}
              textAnchor="middle"
              className="fill-muted font-mono text-[10px]"
            >
              {tick.label}
            </text>
          ))}
        </svg>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-px border border-border bg-border font-mono text-[11px]">
        <div className="bg-surface p-2">
          <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">Ends lower</dt>
          <dd className="text-fg">{pct(simulation.probabilityOfLoss, 0)} of paths</dd>
        </div>
        <div className="bg-surface p-2">
          <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">Median</dt>
          <dd className="text-fg">{signedPct(simulation.percentiles.p50)}</dd>
        </div>
        <div className="bg-surface p-2">
          <dt className="text-[10px] uppercase tracking-[0.1em] text-muted">Paths</dt>
          <dd className="text-fg">{count(simulation.simulations)}</dd>
        </div>
      </dl>
    </div>
  );
}
