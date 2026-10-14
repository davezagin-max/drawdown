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

/** Who does what, in the order it happens. Code owns every number; the model only explains. */
const HOW_IT_WORKS = [
  { who: "Code", what: "computes the risk numbers from five years of daily prices." },
  { who: "AI analyst", what: "explains them, asking the risk engine for each number it needs." },
  { who: "Code", what: "checks every number the analyst quotes and links it to its source." },
];

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
      <section aria-labelledby="intro-title" className="border border-border bg-surface">
        <div className="grid gap-x-10 gap-y-4 px-4 py-4 sm:px-5 sm:py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
              Portfolio risk report
            </p>
            <h1
              id="intro-title"
              className="mt-1.5 text-2xl font-semibold leading-tight tracking-tight text-fg sm:text-[1.75rem]"
            >
              {uploaded
                ? "A risk report for your holdings"
                : "A risk report for a sample stock portfolio"}
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted sm:text-[15px]">
              Code computes every number on this page. An AI analyst (Claude) explains what they
              mean, and every number it quotes links to the calculation it came from.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 lg:items-end">
            <button
              type="button"
              data-cta="play"
              onClick={play}
              disabled={busy || !canPlay}
              title={canPlay ? undefined : "Add your key to run the analyst on your own holdings"}
              className="inline-flex items-center gap-2 bg-accent px-5 py-3 font-mono text-sm font-semibold text-accent-fg shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span aria-hidden>{"▶"}</span>
              {busy ? "Playing…" : playLabel}
            </button>
            <p className="text-xs text-muted">
              {isLive
                ? "Runs live on your key; the cost is shown at the end."
                : "Takes about five seconds. No key or sign-up."}{" "}
              {uploaded ? (
                <button
                  type="button"
                  onClick={() => show(null)}
                  className="text-fg underline decoration-border underline-offset-2 hover:decoration-fg"
                >
                  Back to the sample
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setUploading(true)}
                  className="text-fg underline decoration-border underline-offset-2 hover:decoration-fg"
                >
                  Or load your own holdings
                </button>
              )}
            </p>
          </div>
        </div>
        <ol
          aria-label="How it works"
          className="grid border-t border-border text-xs leading-snug sm:grid-cols-3"
        >
          {HOW_IT_WORKS.map((step, i) => (
            <li
              key={i}
              className="flex items-baseline gap-2 border-border px-4 py-2 sm:px-5 sm:py-2.5 [&:not(:first-child)]:border-t sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-t-0"
            >
              {i > 0 && (
                <span aria-hidden className="font-mono text-muted">
                  {"→"}
                </span>
              )}
              <span>
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-accent">
                  {step.who}
                </span>{" "}
                <span className="text-fg/85">{step.what}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="numbers-title" className="min-w-0 border border-border bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-3 py-2 sm:px-4">
          <h2
            id="numbers-title"
            className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg"
          >
            {uploaded ? "Your holdings" : "The sample portfolio"}
          </h2>
          <p className="text-xs text-muted">
            {count(analysis.holdings.length)} holdings, {usd(analysis.totalValue)}
            {analysis.valueAssumed && " (assumed: the file had weights only)"} {"·"} daily prices,{" "}
            {month(analysis.dataset.start)} to {month(analysis.dataset.end)}
            {analysis.dataset.synthetic && " (simulated)"}
          </p>
        </header>
        <MetricTiles analysis={analysis} />
      </section>

      <AnalystPanel
        analyst={analyst}
        presets={presets}
        placeholder={placeholder}
        custom={uploaded !== null}
        maxQuestionChars={sample.limits.maxQuestionChars}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <Card
            id="drawdown"
            title="Drawdown"
            aside={`growth, and each fall from a high, vs the market (${analysis.assumptions.benchmark})`}
          >
            <PerformanceChart analysis={analysis} />
          </Card>
          <Card
            id="frontier"
            title="Simulated frontier"
            aside="random mixes of the same holdings: risk against return"
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
            aside={`${count(analysis.monteCarlo.simulations)} possible next years`}
            note="Each path resamples real days from the history, so fat tails are kept, but losses do not cluster the way they do in a real sell-off. The dark band holds half the paths, the light band nine tenths."
          >
            <MonteCarloFan analysis={analysis} />
          </Card>
          <Card
            id="correlation"
            title="Correlation"
            aside="which holdings move together"
            className="flex-1"
          >
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
