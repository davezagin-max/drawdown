import { num, pct, usd } from "@/lib/format";
import type { Analysis } from "@/lib/schema";

function Bar({ share, scale, color }: { share: number; scale: number; color: string }) {
  return (
    <span className="block h-1.5 w-full" aria-hidden>
      <span
        className="block h-full rounded-r-[3px]"
        style={{ width: `${Math.max(0, (share / scale) * 100)}%`, background: color }}
      />
    </span>
  );
}

/**
 * Each holding's share of the money next to its share of the risk (its contribution to
 * portfolio variance). The two bars share one scale, so a gap between them is the story.
 */
export function HoldingsTable({ analysis }: { analysis: Analysis }) {
  const scale = Math.max(...analysis.holdings.flatMap((h) => [h.weight, h.riskShare]), 0.01);
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <table className="w-full min-w-[30rem] border-collapse text-xs">
        <caption className="sr-only">
          Holdings with weight, share of risk, beta, volatility, and worst fall
        </caption>
        <thead>
          <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            <th scope="col" className="py-1.5 pr-3 font-normal">
              Holding
            </th>
            <th scope="col" className="w-[24%] py-1.5 pr-3 font-normal">
              <span className="mr-1 inline-block size-2 bg-series-2 align-middle" aria-hidden />{" "}
              Weight
            </th>
            <th scope="col" className="w-[24%] py-1.5 pr-3 font-normal">
              <span className="mr-1 inline-block size-2 bg-series-1 align-middle" aria-hidden />{" "}
              Share of risk
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">
              Beta
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">
              Vol
            </th>
            <th scope="col" className="py-1.5 text-right font-normal">
              Worst fall
            </th>
          </tr>
        </thead>
        <tbody>
          {analysis.holdings.map((holding) => (
            <tr key={holding.ticker} className="border-b border-border/60 last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                <span className="font-mono font-medium text-fg">{holding.ticker}</span>
                <span className="ml-2 hidden text-muted sm:inline">{holding.sector}</span>
                <span className="sr-only">
                  , {holding.name}, {usd(holding.value)}
                </span>
              </th>
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-right font-mono text-fg">
                    {pct(holding.weight, 0)}
                  </span>
                  <Bar share={holding.weight} scale={scale} color="var(--series-2)" />
                </span>
              </td>
              <td className="py-1.5 pr-3">
                <span className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-right font-mono text-fg">
                    {pct(holding.riskShare, 0)}
                  </span>
                  <Bar share={holding.riskShare} scale={scale} color="var(--series-1)" />
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right font-mono text-fg">{num(holding.beta)}</td>
              <td className="py-1.5 pr-3 text-right font-mono text-fg">
                {pct(holding.volatility, 0)}
              </td>
              <td className="py-1.5 text-right font-mono text-fg">{pct(holding.maxDrawdown, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
