import type { Analysis } from "@/lib/schema";
import { day, num, pct, usd } from "@/lib/format";

interface Tile {
  label: string;
  value: string;
  detail: string;
  hint: string;
}

/** The headline row: every number here comes straight from the risk engine's bundle. */
export function MetricTiles({ analysis }: { analysis: Analysis }) {
  const { metrics, benchmark, assumptions, totalValue } = analysis;
  const spy = assumptions.benchmark;
  const fall = metrics.maxDrawdown;
  const tiles: Tile[] = [
    {
      label: "Annual return",
      value: pct(metrics.annualReturn),
      detail: `${spy} ${pct(benchmark.annualReturn)}`,
      hint: "Geometric (compound) growth per year over the whole history.",
    },
    {
      label: "Volatility",
      value: pct(metrics.volatility),
      detail: `${spy} ${pct(benchmark.volatility)}`,
      hint: `Standard deviation of daily returns, annualised over ${assumptions.tradingDaysPerYear} trading days.`,
    },
    {
      label: "Sharpe",
      value: num(metrics.sharpe),
      detail: `${spy} ${num(benchmark.sharpe)}`,
      hint: `Return above a ${pct(assumptions.riskFreeAnnual, 0)} risk-free rate, per unit of volatility.`,
    },
    {
      label: "Sortino",
      value: num(metrics.sortino),
      detail: "downside risk only",
      hint: "Like Sharpe, but only days below the risk-free rate count as risk.",
    },
    {
      label: "Max drawdown",
      value: pct(fall.depth),
      detail: `${spy} ${pct(benchmark.maxDrawdown)}`,
      hint: `Largest peak-to-trough fall: ${day(fall.peakDate)} to ${day(fall.troughDate)}.`,
    },
    {
      label: `Beta vs ${spy}`,
      value: num(metrics.beta),
      detail: metrics.beta >= 1 ? "above the market" : "below the market",
      hint: "Covariance with the benchmark divided by the benchmark's variance.",
    },
    {
      label: "VaR 95%, 1 day",
      value: pct(metrics.var95, 2),
      detail: usd(metrics.var95 * totalValue),
      hint: "On 95% of days the loss was smaller than this. Historical, not a forecast.",
    },
    {
      label: "CVaR 95%, 1 day",
      value: pct(metrics.cvar95, 2),
      detail: usd(metrics.cvar95 * totalValue),
      hint: "Average loss on the worst 5% of days.",
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          title={tile.hint}
          className="flex min-w-0 flex-col gap-1 bg-surface p-3"
        >
          <dt className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            {tile.label}
          </dt>
          <dd className="font-mono text-xl font-medium leading-none text-fg sm:text-2xl xl:text-[1.35rem]">
            {tile.value}
          </dd>
          <dd className="truncate font-mono text-[11px] text-muted">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
