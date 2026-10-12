"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { day, pct } from "@/lib/format";
import { linear, nearest, path, ticks } from "@/lib/scale";
import type { Analysis } from "@/lib/schema";
import { useWidth } from "../hooks";
import { LineKey } from "../ui";

const MARGIN = { left: 44, right: 62, top: 18, bottom: 20 };
const GROWTH_HEIGHT = 168;
const GAP = 30;
const UNDERWATER_HEIGHT = 136;
const HEIGHT = MARGIN.top + GROWTH_HEIGHT + GAP + UNDERWATER_HEIGHT + MARGIN.bottom;

const time = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Two panels on one time axis: growth of $1 against the benchmark, and how far the
 * portfolio sat below its previous high (the "underwater" curve). They are separate
 * panels rather than one chart with two y-axes, so neither scale distorts the other.
 */
export function PerformanceChart({ analysis }: { analysis: Analysis }) {
  const { series, metrics, assumptions } = analysis;
  const fall = metrics.maxDrawdown;
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap, 720);
  const [active, setActive] = useState<number | null>(null);

  const model = useMemo(() => {
    const times = series.dates.map(time);
    const x = linear([times[0], times[times.length - 1]], [MARGIN.left, width - MARGIN.right]);
    const xs = times.map(x);

    const all = [...series.portfolio, ...series.benchmark];
    const low = Math.min(...all);
    const high = Math.max(...all);
    const pad = (high - low) * 0.06;
    const growthTop = MARGIN.top;
    const yGrowth = linear([low - pad, high + pad], [growthTop + GROWTH_HEIGHT, growthTop]);

    const waterTop = growthTop + GROWTH_HEIGHT + GAP;
    const deepest = Math.min(...series.underwater);
    const yWater = linear([deepest * 1.12, 0], [waterTop + UNDERWATER_HEIGHT, waterTop]);

    const years: { x: number; label: string }[] = [];
    const first = new Date(times[0]).getUTCFullYear();
    const last = new Date(times[times.length - 1]).getUTCFullYear();
    for (let year = first + 1; year <= last; year++) {
      years.push({ x: x(Date.UTC(year, 0, 1)), label: String(year) });
    }
    return {
      xs,
      yGrowth,
      yWater,
      growthTop,
      waterTop,
      years,
      growthTicks: ticks(low, high, 3),
      waterTicks: ticks(deepest, 0, 3),
      portfolio: path(xs.map((px, i) => [px, yGrowth(series.portfolio[i])])),
      benchmark: path(xs.map((px, i) => [px, yGrowth(series.benchmark[i])])),
      water: path(xs.map((px, i) => [px, yWater(series.underwater[i])])),
      peak: series.dates.indexOf(fall.peakDate),
      trough: series.dates.indexOf(fall.troughDate),
    };
  }, [series, fall, width]);

  const last = series.dates.length - 1;
  const endPortfolio = model.yGrowth(series.portfolio[last]);
  let endBenchmark = model.yGrowth(series.benchmark[last]);
  // Keep the two end labels from sitting on top of each other.
  if (Math.abs(endPortfolio - endBenchmark) < 13) {
    endBenchmark = endPortfolio + (endBenchmark >= endPortfolio ? 13 : -13);
  }

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setActive(nearest(model.xs, event.clientX - bounds.left));
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const jump = event.shiftKey ? 20 : 1;
    setActive((current) => Math.min(last, Math.max(0, (current ?? model.trough) + step * jump)));
  }

  const bandLeft = model.xs[model.peak] ?? 0;
  const bandRight = model.xs[model.trough] ?? 0;
  const troughY = model.yWater(fall.depth);
  const labelLeft = bandRight + 10 < width - MARGIN.right - 150;
  const activeX = active === null ? 0 : model.xs[active];

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <li className="flex items-center gap-1.5">
          <LineKey color="var(--series-1)" /> Portfolio
        </li>
        <li className="flex items-center gap-1.5">
          <LineKey color="var(--series-2)" /> {assumptions.benchmark} benchmark
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 bg-raised ring-1 ring-border" />{" "}
          Deepest fall, peak to trough
        </li>
      </ul>
      <div
        ref={wrap}
        tabIndex={0}
        role="group"
        aria-label={`Growth of one dollar and drawdown over time. The deepest fall was ${pct(fall.depth)}, from ${day(fall.peakDate)} to ${day(fall.troughDate)}. Use the left and right arrow keys to read values by date.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative"
      >
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block max-w-full touch-pan-y select-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setActive(null)}
          aria-hidden
        >
          {/* the max-drawdown window, shaded through both panels */}
          <rect
            x={bandLeft}
            y={model.growthTop}
            width={Math.max(1, bandRight - bandLeft)}
            height={GROWTH_HEIGHT + GAP + UNDERWATER_HEIGHT}
            fill="var(--raised)"
          />

          {/* growth panel */}
          {model.growthTicks.map((value) => (
            <g key={`g${value}`}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={model.yGrowth(value)}
                y2={model.yGrowth(value)}
                stroke="var(--grid)"
              />
              <text
                x={MARGIN.left - 6}
                y={model.yGrowth(value) + 3.5}
                textAnchor="end"
                className="fill-muted font-mono text-[10px]"
              >
                ${value.toFixed(value % 1 ? 1 : 0)}
              </text>
            </g>
          ))}
          <path
            d={model.benchmark}
            fill="none"
            stroke="var(--series-2)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <path
            d={model.portfolio}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          <text
            x={width - MARGIN.right + 6}
            y={endPortfolio + 3.5}
            className="fill-fg font-mono text-[10px]"
          >
            ${series.portfolio[last].toFixed(2)}
          </text>
          <text
            x={width - MARGIN.right + 6}
            y={endBenchmark + 3.5}
            className="fill-muted font-mono text-[10px]"
          >
            ${series.benchmark[last].toFixed(2)}
          </text>
          <text
            x={MARGIN.left}
            y={model.growthTop - 7}
            className="fill-muted font-mono text-[10px] uppercase tracking-wider"
          >
            Growth of $1
          </text>

          {/* underwater panel */}
          {model.waterTicks.map((value) => (
            <g key={`w${value}`}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={model.yWater(value)}
                y2={model.yWater(value)}
                stroke={value === 0 ? "var(--axis)" : "var(--grid)"}
              />
              <text
                x={MARGIN.left - 6}
                y={model.yWater(value) + 3.5}
                textAnchor="end"
                className="fill-muted font-mono text-[10px]"
              >
                {pct(value, 0)}
              </text>
            </g>
          ))}
          <path
            d={`${model.water}L${model.xs[last].toFixed(1)},${model.yWater(0).toFixed(1)}L${model.xs[0].toFixed(1)},${model.yWater(0).toFixed(1)}Z`}
            fill="var(--series-1)"
            fillOpacity={0.14}
          />
          <path
            d={model.water}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          <circle
            cx={bandRight}
            cy={troughY}
            r={4.5}
            fill="var(--series-1)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
          <text
            x={labelLeft ? bandRight + 12 : bandLeft - 12}
            y={troughY + 4}
            textAnchor={labelLeft ? "start" : "end"}
            paintOrder="stroke"
            stroke="var(--surface)"
            strokeWidth={4}
            strokeLinejoin="round"
            className="fill-fg font-mono text-[11px] font-medium"
          >
            {pct(fall.depth)} on {day(fall.troughDate)}
          </text>
          <text
            x={MARGIN.left}
            y={model.waterTop - 9}
            className="fill-muted font-mono text-[10px] uppercase tracking-wider"
          >
            Below previous high
          </text>

          {model.years.map((year) => (
            <text
              key={year.label}
              x={year.x}
              y={HEIGHT - 5}
              textAnchor="middle"
              className="fill-muted font-mono text-[10px]"
            >
              {year.label}
            </text>
          ))}

          {active !== null && (
            <g pointerEvents="none">
              <line
                x1={activeX}
                x2={activeX}
                y1={model.growthTop}
                y2={HEIGHT - MARGIN.bottom}
                stroke="var(--axis)"
              />
              <circle
                cx={activeX}
                cy={model.yGrowth(series.benchmark[active])}
                r={3.5}
                fill="var(--series-2)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
              <circle
                cx={activeX}
                cy={model.yGrowth(series.portfolio[active])}
                r={3.5}
                fill="var(--series-1)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
              <circle
                cx={activeX}
                cy={model.yWater(series.underwater[active])}
                r={3.5}
                fill="var(--series-1)"
                stroke="var(--surface)"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>

        {active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-1 z-10 w-44 border border-border bg-raised p-2 font-mono text-[11px] shadow-lg"
            style={{ left: activeX > width / 2 ? activeX - 188 : activeX + 12 }}
          >
            <p className="mb-1 text-muted">{day(series.dates[active])}</p>
            <p className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted">
                <LineKey color="var(--series-1)" /> Portfolio
              </span>
              <span className="text-fg">${series.portfolio[active].toFixed(2)}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted">
                <LineKey color="var(--series-2)" /> {assumptions.benchmark}
              </span>
              <span className="text-fg">${series.benchmark[active].toFixed(2)}</span>
            </p>
            <p className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-1">
              <span className="text-muted">Below high</span>
              <span className="text-fg">{pct(series.underwater[active])}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
