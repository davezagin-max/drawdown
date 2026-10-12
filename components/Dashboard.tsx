"use client";

import { useMemo, useState } from "react";
import { count, month, usd } from "@/lib/format";
import type { PortfolioResponse, SampleBundle } from "@/lib/schema";
import { AnalystPanel, type PresetQuestion } from "./AnalystPanel";
import { MetricTiles } from "./MetricTiles";
import { UploadDialog } from "./UploadDialog";
import { CorrelationHeatmap } from "./charts/CorrelationHeatmap";
import { HoldingsTable } from "./charts/HoldingsTable";
import { MonteCarloFan } from "./charts/MonteCarloFan";
import { PerformanceChart } from "./charts/PerformanceChart";
import { SectorBars } from "./charts/SectorBars";
import { Frontier } from "./frontier/Frontier";
import { useKey } from "./kit/KeyProvider";
import { Card } from "./ui";
import { useAnalyst } from "./useAnalyst";

export function Dashboard({
  sample,
  presets,
  placeholder,
}: {
  sample: SampleBundle;
  presets: PresetQuestion[];
  /** True while the bundled analyst sessions are hand-written samples. */
  placeholder: boolean;
}) {
  const { isLive } = useKey();
  const [uploaded, setUploaded] = useState<PortfolioResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const analysis = uploaded?.analysis ?? sample.analysis;

  const custom = useMemo(
    () =>
      uploaded
        ? {
            holdings: uploaded.analysis.holdings.map((h) => ({
              ticker: h.ticker,
              weight: h.weight,
            })),
            totalValue: uploaded.analysis.totalValue,
          }
        : null,
    [uploaded],
  );
  const analyst = useAnalyst(custom);
  const busy = analyst.state.status === "running";
  const canPlay = isLive || !uploaded;

  function play() {
    const first = presets[0];
    if (!first) return;
    analyst.run(
      isLive ? { question: first.question } : { demoId: first.demoId, question: first.question },
    );
    // On a phone the analyst sits below the numbers; bring it up so the run is visible.
    const panel = document.getElementById("analyst");
    if (panel && panel.getBoundingClientRect().top > window.innerHeight * 0.55) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  }

  function show(next: PortfolioResponse | null) {
    analyst.reset(); // a session describes one portfolio; it must not outlive it
    setUploaded(next);
  }

  // The button plays the first preset, so its wording follows that preset's own fixture.
  const playLabel = isLive
    ? "Ask the analyst"
    : (presets[0]?.placeholder ?? placeholder)
      ? "Play a sample analyst session"
      : "Replay a recorded analyst session";

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-3 px-3 py-3 sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border border-border bg-surface px-3 py-2.5">
        <div className="min-w-0">
          <h1 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
            {uploaded ? "Your holdings" : "Sample portfolio"}
          </h1>
          <p className="mt-0.5 text-sm text-fg">
            {count(analysis.holdings.length)} holdings, {usd(analysis.totalValue)}
            {analysis.valueAssumed && (
              <span className="text-muted"> (assumed: the file had weights only)</span>
            )}
            <span className="text-muted">
              {" "}
              {"·"} {month(analysis.dataset.start)} to {month(analysis.dataset.end)},{" "}
              {count(analysis.dataset.tradingDays)} trading days
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {uploaded ? (
            <button
              type="button"
              onClick={() => show(null)}
              className="border border-border px-3 py-2 font-mono text-xs text-fg hover:bg-raised"
            >
              Back to the sample
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setUploading(true)}
              className="border border-border px-3 py-2 font-mono text-xs text-fg hover:bg-raised"
            >
              Load your holdings
            </button>
          )}
          <button
            type="button"
            data-cta="play"
            onClick={play}
            disabled={busy || !canPlay}
            title={canPlay ? undefined : "Add your key to run the analyst on your own holdings"}
            className="bg-accent px-3 py-2 font-mono text-xs font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden>{"▶ "}</span>
            {busy ? "Running…" : playLabel}
          </button>
        </div>
      </div>

      <MetricTiles analysis={analysis} />

      <AnalystPanel
        analyst={analyst}
        presets={presets}
        placeholder={placeholder}
        custom={uploaded !== null}
        maxQuestionChars={sample.limits.maxQuestionChars}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <Card id="drawdown" title="Drawdown" aside={`vs ${analysis.assumptions.benchmark}`}>
            <PerformanceChart analysis={analysis} />
          </Card>
          <Card
            id="frontier"
            title="Simulated frontier"
            aside="risk, return, worst fall"
            className="flex-1"
            fill
          >
            <Frontier
              key={uploaded ? "uploaded" : "sample"}
              frontier={uploaded?.frontier ?? null}
              holdings={analysis.holdings.length}
            />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Card id="sectors" title="Sector exposure" aside="share of value">
            <SectorBars analysis={analysis} />
          </Card>
          <Card
            id="montecarlo"
            title="Monte Carlo, one year"
            aside="resampled history"
            note="Each path resamples real days from the history, so fat tails are kept, but losses do not cluster the way they do in a real sell-off. The dark band holds half the paths, the light band nine tenths."
          >
            <MonteCarloFan analysis={analysis} />
          </Card>
          <Card id="correlation" title="Correlation" aside="daily returns" className="flex-1">
            <CorrelationHeatmap analysis={analysis} />
          </Card>
        </div>

        <Card
          id="holdings"
          title="Holdings"
          aside="weight against share of risk"
          className="lg:col-span-3"
          note="Share of risk is each holding's contribution to portfolio variance. A negative share means the holding has moved against the rest and dampened the swings."
        >
          <HoldingsTable analysis={analysis} />
        </Card>
      </div>

      <p className="px-1 text-xs leading-relaxed text-muted">
        Conventions: simple daily returns; a {analysis.assumptions.tradingDaysPerYear}-day year;
        sample standard deviation; a constant{" "}
        {Math.round(analysis.assumptions.riskFreeAnnual * 100)}% risk-free rate; VaR and CVaR are
        historical one-day figures shown as positive losses; weights are held fixed (rebalanced
        daily).
      </p>

      <UploadDialog
        open={uploading}
        onClose={() => setUploading(false)}
        onLoaded={show}
        universe={sample.universe}
        limits={sample.limits}
      />
    </main>
  );
}
