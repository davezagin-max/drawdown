"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { NumberCheck, Provenance, Session, ToolCall } from "@/lib/schema";
import { callHeadline, callSignature } from "@/lib/session";
import { CostMeter } from "./kit/CostMeter";
import { useKey } from "./kit/KeyProvider";
import type { Analyst, AnalystState } from "./useAnalyst";

export interface PresetQuestion {
  demoId: string;
  question: string;
}

const PRESET_LABELS: Record<string, string> = {
  "risk-sources": "Where is the risk coming from?",
  "market-drop": "Market falls 20%, tech a further 10%",
  "trim-tech": "Cut technology to 20%",
};

function sourceLine(source: { mode: "live" | "demo"; placeholder: boolean }): string {
  if (source.mode === "live") return "Live: Claude Opus 5.5, on your key.";
  return source.placeholder
    ? "Sample session. The notes and the answer are hand-written until a real run is recorded. Every tool output is computed by the risk engine."
    : "A recorded Claude Opus 5.5 session, replayed.";
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

function CallRow({ call, index, active }: { call: ToolCall; index: number; active: boolean }) {
  const headline = callHeadline(call);
  return (
    <li>
      <details
        id={`call-${call.id}`}
        className={`group border bg-bg ${active ? "border-accent" : "border-border"}`}
      >
        <summary className="flex cursor-pointer list-none items-start gap-2 px-2 py-1.5 font-mono text-[11px] leading-snug [&::-webkit-details-marker]:hidden">
          <span
            className={`mt-px shrink-0 px-1 text-[10px] ${
              active ? "bg-accent text-accent-fg" : "bg-raised text-muted"
            }`}
          >
            {index}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-x-3">
            <span className="break-words text-fg">{callSignature(call)}</span>
            {call.isError ? (
              <span className="text-danger">error returned to the model</span>
            ) : (
              headline.length > 0 && (
                <span className="text-muted">
                  {headline.map((h) => `${h.label} ${trimNumber(h.value)}`).join(" \u00b7 ")}
                </span>
              )
            )}
          </span>
          <span aria-hidden className="shrink-0 text-muted group-open:rotate-90">
            {"▸"}
          </span>
        </summary>
        <pre className="max-h-56 overflow-auto border-t border-border p-2 font-mono text-[10px] leading-relaxed text-muted">
          {JSON.stringify({ input: call.input, output: call.output }, null, 1)}
        </pre>
      </details>
    </li>
  );
}

function Chip({
  check,
  callIndex,
  active,
  onSelect,
}: {
  check: NumberCheck;
  callIndex: number | null;
  active: boolean;
  onSelect: () => void;
}) {
  const style =
    check.status === "matched"
      ? "border-accent bg-accent-soft text-fg"
      : check.status === "question"
        ? "border-dashed border-muted text-fg"
        : "border-danger bg-danger-soft text-danger";
  const label =
    check.status === "matched"
      ? `${check.text}, from tool call ${callIndex}`
      : check.status === "question"
        ? `${check.text}, restated from the question`
        : `${check.text}, not from a tool`;
  return (
    <button
      type="button"
      data-status={check.status}
      aria-label={label}
      aria-pressed={active}
      onClick={onSelect}
      onMouseEnter={onSelect}
      onFocus={onSelect}
      className={`mx-px inline whitespace-nowrap border-b px-1 font-mono text-[0.92em] leading-tight ${style} ${
        active ? "outline outline-1 outline-fg" : ""
      }`}
    >
      {check.text}
      <sup aria-hidden className="ml-0.5 text-[0.7em] font-medium">
        {check.status === "matched" ? callIndex : check.status === "question" ? "q" : "?"}
      </sup>
    </button>
  );
}

function Answer({
  provenance,
  calls,
  activeNumber,
  onSelect,
}: {
  provenance: Provenance;
  calls: ToolCall[];
  activeNumber: number | null;
  onSelect: (index: number) => void;
}) {
  const indexOf = (callId: string | null) => {
    const at = calls.findIndex((call) => call.id === callId);
    return at < 0 ? null : at + 1;
  };
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-fg">
      {provenance.segments.map((segment, i) => {
        const check = segment.number == null ? null : provenance.numbers[segment.number];
        if (!check || segment.number == null) return <span key={i}>{segment.text}</span>;
        const n = segment.number;
        return (
          <Chip
            key={i}
            check={check}
            callIndex={indexOf(check.callId)}
            active={activeNumber === n}
            onSelect={() => onSelect(n)}
          />
        );
      })}
    </p>
  );
}

function SourceLine({ check, calls }: { check: NumberCheck | null; calls: ToolCall[] }) {
  if (!check) {
    return <>Select a highlighted figure to see the tool output it came from.</>;
  }
  if (check.status === "unmatched") {
    return (
      <span className="text-danger">
        {check.text} is not from a tool: no tool output in this session rounds to it.
      </span>
    );
  }
  if (check.status === "question") {
    return <>{check.text} restates a figure from the question. No tool returned it.</>;
  }
  const at = calls.findIndex((call) => call.id === check.callId);
  const call = calls[at];
  return (
    <>
      <span className="text-fg">{check.text}</span> {"←"} call {at + 1},{" "}
      <span className="break-words text-fg">{call ? callSignature(call) : check.tool}</span>,{" "}
      {check.path} = <span className="text-fg">{trimNumber(check.sourceValue ?? 0)}</span>
      {check.approximate && " (a round figure, matched loosely)"}
      {check.alternatives > 0 &&
        `. ${check.alternatives} other tool output${check.alternatives === 1 ? "" : "s"} also round${check.alternatives === 1 ? "s" : ""} to this figure.`}
    </>
  );
}

function Verdict({ session, altered }: { session: Session; altered: boolean }) {
  const provenance = altered && session.selfTest ? session.selfTest.provenance : session.provenance;
  const total = provenance.numbers.length;
  if (total === 0) {
    return (
      <p className="font-mono text-[11px] text-muted">The answer contains no figures to check.</p>
    );
  }
  const clean = provenance.unmatched === 0;
  return (
    <p
      data-verdict={clean ? "clean" : "flagged"}
      className={`font-mono text-[11px] ${clean ? "text-success" : "text-danger"}`}
    >
      <span aria-hidden>{clean ? "✓ " : "⚠ "}</span>
      {provenance.matched} of {total} figures traced to a tool output
      {provenance.fromQuestion > 0 && `, ${provenance.fromQuestion} restated from the question`}
      {provenance.unmatched > 0 && `, ${provenance.unmatched} not from a tool`}.
    </p>
  );
}

/** One run: the trail as it streams, then the checked answer. Remounted for every run. */
function SessionView({
  state,
  onStop,
  onAddKey,
  isLive,
}: {
  state: AnalystState;
  onStop: () => void;
  onAddKey: () => void;
  isLive: boolean;
}) {
  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [altered, setAltered] = useState(false);
  const busy = state.status === "running";
  const session = state.session;
  const showing = session
    ? altered && session.selfTest
      ? session.selfTest.provenance
      : session.provenance
    : null;
  const activeCheck =
    showing && activeNumber !== null ? (showing.numbers[activeNumber] ?? null) : null;
  const source = state.source ?? (isLive ? { mode: "live" as const, placeholder: false } : null);

  // When the answer lands below the fold (always, on a phone), bring it into view.
  const answer = useRef<HTMLDivElement>(null);
  const finished = state.status === "done";
  useEffect(() => {
    if (!finished) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    answer.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, [finished]);

  return (
    <div data-session={state.status} className="border-t border-border" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-snug text-fg">{state.question}</p>
          {source && (
            <p className="mt-1 text-xs leading-relaxed text-muted">{sourceLine(source)}</p>
          )}
        </div>
        {busy && (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 border border-border px-2.5 py-1 font-mono text-[11px] text-muted hover:bg-raised hover:text-fg"
          >
            Stop
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-3 p-3 lg:border-r lg:border-border">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            Tool calls
          </h3>
          <ol className="flex flex-col gap-3" aria-live="polite">
            {state.trail.retried && (
              <li className="font-mono text-[11px] text-muted">
                The first answer used no tools, so it was thrown away and the question asked again.
              </li>
            )}
            {state.trail.rounds.map((round, position) => {
              const last = position === state.trail.rounds.length - 1;
              const offset = state.trail.rounds
                .slice(0, position)
                .reduce((sum, earlier) => sum + earlier.calls.length, 0);
              return (
                <li key={round.round} className="flex flex-col gap-1.5">
                  <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    <span className="text-fg">Round {round.round}</span>
                    {round.calls.length > 1 && (
                      <span>{round.calls.length} tool calls in parallel</span>
                    )}
                    {round.calls.length === 1 && <span>1 tool call</span>}
                    {round.calls.length === 0 && session && <span>writes the answer</span>}
                    {busy && last && round.calls.length === 0 && (
                      <span className="cursor-blink text-accent">working</span>
                    )}
                  </p>
                  {round.notes.map((note, i) => (
                    <p
                      key={i}
                      className="border-l border-accent pl-2 text-xs leading-relaxed text-muted"
                    >
                      {note}
                    </p>
                  ))}
                  {round.calls.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {round.calls.map((call, i) => (
                        <CallRow
                          key={call.id}
                          call={call}
                          index={offset + i + 1}
                          active={activeCheck?.callId === call.id}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          {state.status === "stopped" && (
            <p role="status" className="font-mono text-[11px] text-muted">
              Stopped.{" "}
              {source?.mode === "live"
                ? "The connection was closed, so the analyst makes no further model calls."
                : "The replay was cut short."}
            </p>
          )}
        </div>

        <div
          ref={answer}
          className="flex min-w-0 scroll-mb-4 scroll-mt-12 flex-col gap-2.5 border-t border-border p-3 lg:border-t-0"
        >
          <h3 className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Answer</h3>
          {busy && (
            <p className="text-xs leading-relaxed text-muted">
              The answer appears here once the tools have returned. Each figure in it is then
              matched against the tool outputs on the left.
            </p>
          )}

          {state.status === "stopped" && (
            <p className="text-xs leading-relaxed text-muted">
              No answer: the run was stopped before the analyst finished.
            </p>
          )}

          {state.error && (
            <div
              role="alert"
              className="border border-danger bg-danger-soft p-2.5 text-xs leading-relaxed text-danger"
            >
              <p className="font-medium">
                {state.error.kind === "refusal"
                  ? "Claude declined"
                  : state.error.kind === "demo_miss"
                    ? "Not available in demo mode"
                    : state.error.kind === "auth"
                      ? "Key problem"
                      : state.error.kind === "rate_limit"
                        ? "Too many requests"
                        : "The session did not finish"}
              </p>
              <p>{state.error.message}</p>
              {(state.error.kind === "demo_miss" || state.error.kind === "auth") && (
                <button
                  type="button"
                  onClick={onAddKey}
                  className="mt-1 underline underline-offset-2"
                >
                  {state.error.kind === "auth" ? "Change key" : "Add your key"}
                </button>
              )}
            </div>
          )}

          {session && showing && (
            <>
              {!session.usedTools && (
                <p
                  role="alert"
                  className="border border-danger bg-danger-soft p-2 text-xs text-danger"
                >
                  The analyst answered without a successful tool call, so none of the figures below
                  are verified.
                </p>
              )}
              {altered && session.selfTest && (
                <p className="border border-border bg-raised p-2 text-xs leading-relaxed text-muted">
                  This page changed{" "}
                  <span className="font-mono text-fg">{session.selfTest.original}</span> to{" "}
                  <span className="font-mono text-fg">{session.selfTest.altered}</span>, then ran
                  the checker again. The altered figure is flagged; the analyst did not write it.
                </p>
              )}
              <Answer
                provenance={showing}
                calls={session.calls}
                activeNumber={activeNumber}
                onSelect={setActiveNumber}
              />
              <Verdict session={session} altered={altered} />
              <p role="status" className="min-h-8 font-mono text-[11px] leading-relaxed text-muted">
                <SourceLine check={activeCheck} calls={session.calls} />
              </p>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                {session.selfTest && (
                  <button
                    type="button"
                    data-action="self-test"
                    aria-pressed={altered}
                    onClick={() => {
                      setAltered((value) => !value);
                      setActiveNumber(null);
                    }}
                    className="border border-border px-2 py-1 font-mono text-[11px] text-muted hover:bg-raised hover:text-fg"
                  >
                    {altered ? "Show the real answer" : "Test the checker: alter a figure"}
                  </button>
                )}
                <CostMeter meta={state.meta} />
              </div>
            </>
          )}
          {!session && state.meta && <CostMeter meta={state.meta} />}
        </div>
      </div>
    </div>
  );
}

export function AnalystPanel({
  analyst,
  presets,
  placeholder,
  custom,
  maxQuestionChars,
}: {
  analyst: Analyst;
  presets: PresetQuestion[];
  /** True while the bundled sessions are hand-written samples, not recorded runs. */
  placeholder: boolean;
  /** The dashboard is showing uploaded holdings rather than the sample portfolio. */
  custom: boolean;
  maxQuestionChars: number;
}) {
  const { isLive, openKeyModal } = useKey();
  const { state, run, stop } = analyst;
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const busy = state.status === "running";
  const presetsUsable = isLive || !custom;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (question && isLive && !busy) run({ question });
  }

  return (
    <section
      id="analyst"
      aria-labelledby="analyst-title"
      className="min-w-0 scroll-mt-12 border border-border bg-surface"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        <h2
          id="analyst-title"
          className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg"
        >
          Analyst
        </h2>
        <p className="font-mono text-[11px] text-muted">
          {isLive
            ? "live, on your key"
            : placeholder
              ? "sample sessions until a real run is recorded"
              : "recorded Claude Opus 5.5 sessions"}
        </p>
      </header>

      <div className="grid gap-x-6 gap-y-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted">
            The analyst sees ticker names and four tools, and no numbers. Every figure it quotes has
            to come back from the risk engine, and code checks each one afterwards.
          </p>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
            {presets.map((preset) => (
              <button
                key={preset.demoId}
                type="button"
                data-preset={preset.demoId}
                disabled={busy || !presetsUsable}
                title={preset.question}
                onClick={() => run(isLive ? { question: preset.question } : preset)}
                className="flex items-center justify-between gap-2 border border-border bg-bg px-2.5 py-2 text-left text-xs text-fg hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{PRESET_LABELS[preset.demoId] ?? preset.question}</span>
                <span aria-hidden className="font-mono text-accent">
                  {"▸"}
                </span>
              </button>
            ))}
          </div>
          {!presetsUsable && (
            <p className="text-xs leading-relaxed text-muted">
              The bundled sessions describe the sample portfolio, so they are switched off for your
              holdings.{" "}
              <button
                type="button"
                onClick={openKeyModal}
                className="text-accent underline underline-offset-2"
              >
                Add your key
              </button>{" "}
              to run the analyst on them live.
            </p>
          )}
        </div>

        <form onSubmit={submit} className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor={inputId}
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted"
          >
            Your own question
          </label>
          <div className="flex gap-1.5">
            <input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={maxQuestionChars}
              disabled={!isLive || busy}
              aria-describedby={`${inputId}-hint`}
              placeholder={isLive ? "What if bonds fall 15%?" : "Needs your Anthropic key"}
              className="min-w-0 flex-1 border border-border bg-bg px-2.5 py-2 text-sm text-fg placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!isLive || busy || !draft.trim()}
              className="shrink-0 bg-accent px-3 py-2 font-mono text-xs font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Ask
            </button>
          </div>
          <p id={`${inputId}-hint`} className="text-xs leading-relaxed text-muted">
            {isLive ? (
              "Runs on your key. The cost is shown when it finishes."
            ) : (
              <>
                Free-form questions call Claude, so they need a key.{" "}
                <button
                  type="button"
                  onClick={openKeyModal}
                  className="text-accent underline underline-offset-2"
                >
                  Add your key
                </button>{" "}
                or pick a preset.
              </>
            )}
          </p>
        </form>
      </div>

      {state.status !== "idle" && (
        <SessionView
          key={state.run}
          state={state}
          onStop={stop}
          onAddKey={openKeyModal}
          isLive={isLive}
        />
      )}
    </section>
  );
}
