"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { count } from "@/lib/format";
import { analyzeCsv, hasRiskApi } from "@/lib/risk-api";
import type { PortfolioResponse, SampleBundle } from "@/lib/schema";

/**
 * Load a holdings CSV. The file is read in the browser, sent to the risk engine API,
 * analysed in memory there, and never stored. Limits are enforced on both sides.
 */
export function UploadDialog({
  open,
  onClose,
  onLoaded,
  universe,
  limits,
}: {
  open: boolean;
  onClose: () => void;
  onLoaded: (result: PortfolioResponse) => void;
  universe: SampleBundle["universe"];
  limits: SampleBundle["limits"];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    setBusy(false);
    setError(null);
    onClose();
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again should still fire
    if (!file) return;
    setError(null);
    if (file.size > limits.maxCsvBytes) {
      setError(`That file is too large. The limit is ${Math.round(limits.maxCsvBytes / 1000)} KB.`);
      return;
    }
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    const result = await analyzeCsv(await file.text(), abort.signal);
    if (abort.signal.aborted) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onLoaded(result.data);
    onClose();
  }

  return (
    <dialog
      ref={dialog}
      onClose={close}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
      aria-labelledby="upload-title"
      className="m-auto w-[min(34rem,calc(100vw-2rem))] border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/60"
    >
      <div className="flex flex-col gap-4 p-5">
        <h2 id="upload-title" className="font-mono text-sm font-medium uppercase tracking-[0.12em]">
          Load your holdings
        </h2>
        {hasRiskApi ? (
          <>
            <p className="text-sm leading-relaxed text-muted">
              A CSV with a <code className="font-mono text-fg">ticker</code> column and either{" "}
              <code className="font-mono text-fg">value</code> (dollars) or{" "}
              <code className="font-mono text-fg">weight</code>. Between {limits.minHoldings} and{" "}
              {limits.maxHoldings} holdings, up to {Math.round(limits.maxCsvBytes / 1000)} KB.
            </p>
            <pre className="overflow-x-auto border border-border bg-bg p-2.5 font-mono text-xs leading-relaxed text-muted">
              {"ticker,value\nAAPL,12000\nJPM,8000\nTLT,5000"}
            </pre>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={input}
                id="holdings-file"
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                disabled={busy}
                className="sr-only"
              />
              <label
                htmlFor="holdings-file"
                className={`cursor-pointer bg-accent px-3 py-2 font-mono text-xs font-medium text-accent-fg focus-within:outline focus-within:outline-2 has-[:focus-visible]:outline ${
                  busy ? "pointer-events-none opacity-50" : ""
                }`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") input.current?.click();
                }}
                tabIndex={0}
                role="button"
              >
                {busy ? "Analysing…" : "Choose a CSV file"}
              </label>
              <a
                href="/sample-holdings.csv"
                download
                className="text-xs text-accent underline underline-offset-2"
              >
                Download an example
              </a>
            </div>
            {error && (
              <p
                role="alert"
                className="border border-danger bg-danger-soft p-2.5 text-sm text-danger"
              >
                {error}
              </p>
            )}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">
                The {count(universe.length)} symbols that can be analysed
              </summary>
              <p className="mt-2 font-mono leading-relaxed">
                {universe.map((security) => security.ticker).join(" ")}
              </p>
            </details>
            <p className="text-xs leading-relaxed text-muted">
              Your file is analysed in memory and never stored. Prices are simulated, so the result
              describes how this tool works, not how your real portfolio behaved.
            </p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Analysing your own holdings needs the Python risk engine, and this deployment is not
            connected to one. Everything on the sample portfolio works without it. To try your own
            file, run the project locally: the README has the two commands.
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={close}
            className="border border-border px-3 py-2 font-mono text-xs hover:bg-raised"
          >
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
