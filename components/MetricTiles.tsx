import type { Analysis } from "@/lib/schema";
import { day, num, pct, usd } from "@/lib/format";

interface Tile {
  label: string;
  /** What the number means, in a phrase a non-specialist can read at a glance. */
  plain: string;
  value: string;
  detail: string;
  /** The exact definition, for the tooltip. */
  hint: string;
}

/** The headline row: every number here comes straight from the risk engine's bundle. */
export function MetricTiles({ analysis }: { analysis: Analysis }) {
  const { metrics, benchmark, assumptions, totalValue } = analysis;
  const spy = assumptions.benchmark;
  const market = `Market (${spy})`;
  const fall = metrics.maxDrawdown;
  // Ordered so the row reads from the familiar (growth, worst fall) to the specialist.
  const tiles: Tile[] = [
    {
      label: "Annual return",
      plain: "Average growth per year",
      value: pct(metrics.annualReturn),
      detail: `${market} ${pct(benchmark.annualReturn)}`,
      hint: "Geometric (compound) growth per year over the whole history.",
    },
    {
      label: "Max drawdown",
      plain: "Worst fall from a high point",
      value: pct(fall.depth),
      detail: `${market} ${pct(benchmark.maxDrawdown)}`,
      hint: `Largest peak-to-trough fall: ${day(fall.peakDate)} to ${day(fall.troughDate)}.`,
    },
    {
      label: "Volatility",
      plain: "How much it swings in a year",
      value: pct(metrics.volatility),
      detail: `${market} ${pct(benchmark.volatility)}`,
      hint: `Standard deviation of daily returns, annualised over ${assumptions.tradingDaysPerYear} trading days.`,
    },
    {
      label: `Beta vs ${spy}`,
      plain: "How closely it follows the market",
      value: num(metrics.beta),
      detail: `${market} 1.00`,
      hint: "Covariance with the benchmark divided by the benchmark's variance. Above 1 means it tends to move more than the market.",
    },
    {
      label: "Sharpe ratio",
      plain: "Return per unit of risk; higher is better",
      value: num(metrics.sharpe),
      detail: `${market} ${num(benchmark.sharpe)}`,
      hint: `Return above a ${pct(assumptions.riskFreeAnnual, 0)} risk-free rate, per unit of volatility.`,
    },
    {
      label: "Sortino ratio",
      plain: "Like Sharpe, but only losses count as risk",
      value: num(metrics.sortino),
      detail: "downside swings only",
      hint: "Like Sharpe, but only days below the risk-free rate count as risk.",
    },
    {
      label: "VaR 95%, 1 day",
      plain: "A bad day: worse only 1 day in 20",
      value: pct(metrics.var95, 2),
      detail: `about ${usd(metrics.var95 * totalValue)}`,
      hint: "Value at risk: on 95% of days the loss was smaller than this. Historical, not a forecast.",
    },
    {
      label: "CVaR 95%, 1 day",
      plain: "Average loss on those worst days",
      value: pct(metrics.cvar95, 2),
      detail: `about ${usd(metrics.cvar95 * totalValue)}`,
      hint: "Conditional value at risk: the average loss on the worst 5% of days.",
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          title={tile.hint}
          className="flex min-w-0 flex-col bg-surface px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <dt className="flex flex-col gap-0.5">
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {tile.label}
            </span>
            <span className="text-xs leading-snug text-fg/85">{tile.plain}</span>
          </dt>
          <dd className="mt-2 font-mono text-xl font-medium leading-none text-fg sm:text-2xl">
            {tile.value}
          </dd>
          <dd className="mt-1.5 truncate font-mono text-[11px] text-muted">{tile.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
