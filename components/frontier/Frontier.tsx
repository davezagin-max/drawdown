"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildCloud } from "@/lib/cloud";
import { count, num, pct } from "@/lib/format";
import { Frontier as FrontierSchema, type Frontier as FrontierData } from "@/lib/schema";

function Loading({ text = "Loading the frontier…" }: { text?: string }) {
  return (
    <div className="flex min-h-[340px] flex-1 items-center justify-center font-mono text-xs text-muted sm:min-h-[400px]">
      {text}
    </div>
  );
}

// three.js and the 3,000-point cloud stay out of the first-load bundle.
const Frontier3D = dynamic(() => import("./Frontier3D"), {
  ssr: false,
  loading: () => <Loading />,
});
const Frontier2D = dynamic(() => import("./Frontier2D"), {
  ssr: false,
  loading: () => <Loading />,
});

const SWATCH: Record<string, string> = {
  current: "var(--seq-hi)",
  maxSharpe: "var(--success)",
  minVolatility: "var(--series-2)",
};

/**
 * The simulated frontier. `frontier` is the uploaded portfolio's cloud when there is
 * one; for the sample portfolio it is null and the bundled cloud is fetched on demand.
 */
export function Frontier({
  frontier,
  holdings,
}: {
  frontier: FrontierData | null;
  holdings: number;
}) {
  const [bundled, setBundled] = useState<FrontierData | null>(null);
  const [failed, setFailed] = useState(false);
  const [flat, setFlat] = useState(false);
  const [noWebgl, setNoWebgl] = useState(false);
  const [spin, setSpin] = useState(true);

  useEffect(() => {
    if (frontier) return;
    let cancelled = false;
    import("@/fixtures/frontier.json")
      .then((module) => {
        const parsed = FrontierSchema.safeParse(module.default);
        if (cancelled) return;
        if (parsed.success) setBundled(parsed.data);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [frontier]);

  const data = frontier ?? bundled;
  const cloud = useMemo(() => (data ? buildCloud(data) : null), [data]);
  const onUnavailable = useCallback(() => setNoWebgl(true), []);

  if (failed) return <Loading text="The frontier data could not be loaded." />;
  if (!cloud || !data) return <Loading />;
  const twoD = flat || noWebgl;

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted">
          <span>
            Sharpe {"\u2264"} {num(cloud.sharpe.min, 1)}
          </span>
          <span
            aria-hidden
            className="h-2 w-20"
            style={{
              background: "linear-gradient(90deg, var(--seq-lo), var(--seq-mid), var(--seq-hi))",
            }}
          />
          <span>
            {"\u2265"} {num(cloud.sharpe.max, 1)}
          </span>
        </div>
        <div className="flex gap-1 font-mono text-[11px]">
          {!twoD && (
            <button
              type="button"
              aria-pressed={spin}
              onClick={() => setSpin((value) => !value)}
              className="border border-border px-2 py-1 text-muted hover:bg-raised hover:text-fg"
            >
              {spin ? "Pause rotation" : "Rotate"}
            </button>
          )}
          {!noWebgl && (
            <button
              type="button"
              aria-pressed={flat}
              onClick={() => setFlat((value) => !value)}
              className="border border-border px-2 py-1 text-muted hover:bg-raised hover:text-fg"
            >
              {flat ? "Show in 3D" : "Show in 2D"}
            </button>
          )}
        </div>
      </div>

      {twoD ? (
        <Frontier2D cloud={cloud} />
      ) : (
        <Frontier3D cloud={cloud} spin={spin} onUnavailable={onUnavailable} />
      )}
      {noWebgl && (
        <p className="mt-1 text-xs text-muted">
          WebGL is not available in this browser, so the cloud is drawn in 2D (risk against return).
        </p>
      )}

      <div className="-mx-3 mt-3 overflow-x-auto px-3">
        <table className="w-full min-w-[24rem] border-collapse text-xs">
          <caption className="sr-only">The three highlighted portfolios</caption>
          <thead>
            <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
              <th scope="col" className="py-1.5 pr-3 font-normal">
                Highlighted
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                Volatility
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                Return
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                Sharpe
              </th>
              <th scope="col" className="py-1.5 text-right font-normal">
                Worst fall
              </th>
            </tr>
          </thead>
          <tbody>
            {cloud.highlights.map((highlight) => (
              <tr key={highlight.key} className="border-b border-border/60 last:border-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg">
                  <span
                    aria-hidden
                    className="mr-2 inline-block size-2.5 rounded-full align-middle ring-2 ring-fg"
                    style={{ background: SWATCH[highlight.key] }}
                  />
                  {highlight.label}
                  {highlight.key !== "current" && <span className="text-muted"> in the cloud</span>}
                </th>
                <td className="py-1.5 pr-3 text-right font-mono text-fg">
                  {pct(highlight.point.volatility)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-fg">
                  {pct(highlight.point.annualReturn)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-fg">
                  {num(highlight.point.sharpe)}
                </td>
                <td className="py-1.5 text-right font-mono text-fg">
                  {pct(highlight.point.maxDrawdown)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {count(data.count)} random long-only mixes of the same {holdings} holdings, each measured
        over the same history with the same formulas as the headline numbers. This is hindsight on
        simulated prices: it shows how much the mix matters, not which mix to hold.
      </p>
    </div>
  );
}
