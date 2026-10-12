import { pct } from "@/lib/format";
import type { Analysis } from "@/lib/schema";

/** Share of the portfolio's value in each sector, largest first. One series, one color. */
export function SectorBars({ analysis }: { analysis: Analysis }) {
  const largest = Math.max(...analysis.sectors.map((s) => s.weight));
  return (
    <ul className="flex flex-col gap-2">
      {analysis.sectors.map((sector) => (
        <li
          key={sector.sector}
          className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3rem] items-center gap-2 text-xs"
        >
          <span className="truncate text-muted" title={sector.sector}>
            {sector.sector}
          </span>
          <span className="h-2.5">
            <span
              className="block h-full rounded-r-[4px] bg-series-1"
              style={{ width: `${Math.max(1, (sector.weight / largest) * 100)}%` }}
            />
          </span>
          <span className="text-right font-mono text-fg">{pct(sector.weight, 0)}</span>
        </li>
      ))}
    </ul>
  );
}
