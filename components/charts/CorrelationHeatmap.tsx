"use client";

import { useState, type KeyboardEvent } from "react";
import { num } from "@/lib/format";
import type { Analysis } from "@/lib/schema";

/** Neutral at zero, blue toward -1, amber toward +1: two opposite hues around a gray midpoint. */
function fill(value: number): string {
  const strength = Math.round(Math.min(1, Math.abs(value)) * 100);
  const pole = value < 0 ? "var(--div-neg)" : "var(--div-pos)";
  return `color-mix(in oklab, ${pole} ${strength}%, var(--div-mid))`;
}

const short = (value: number) => num(value, 2).replace(/^(−?)0\./, "$1.");

/**
 * Pairwise correlation of daily returns. Holdings are grouped by sector, so related
 * names form visible blocks. One tab stop; arrow keys move between cells.
 */
export function CorrelationHeatmap({ analysis }: { analysis: Analysis }) {
  const { tickers, matrix } = analysis.correlation;
  const size = tickers.length;
  const [cell, setCell] = useState<[number, number] | null>(null);
  const labelled = size <= 20;
  const numbered = size <= 12;

  const pairs = [];
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++)
      pairs.push({ a: tickers[i], b: tickers[j], value: matrix[i][j] });
  }
  pairs.sort((x, y) => x.value - y.value);
  const lowest = pairs[0];
  const highest = pairs[pairs.length - 1];

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setCell((current) => {
      const [row, column] = current ?? [0, 0];
      return [
        Math.min(size - 1, Math.max(0, row + move[0])),
        Math.min(size - 1, Math.max(0, column + move[1])),
      ];
    });
  }

  const active = cell
    ? { a: tickers[cell[0]], b: tickers[cell[1]], value: matrix[cell[0]][cell[1]] }
    : null;

  return (
    <div>
      <div
        tabIndex={0}
        role="group"
        aria-label={`Correlation matrix of ${size} holdings. Use the arrow keys to read each pair.`}
        onKeyDown={onKey}
        onFocus={() => setCell((current) => current ?? [0, 0])}
        onBlur={() => setCell(null)}
        onPointerLeave={() => setCell(null)}
        className="grid gap-[2px]"
        style={{
          gridTemplateColumns: `${labelled ? "max-content " : ""}repeat(${size}, minmax(0, 1fr))`,
        }}
      >
        {matrix.map((row, i) => (
          <div key={tickers[i]} className="contents">
            {labelled && (
              <span className="flex items-center justify-end pr-1.5 font-mono text-[10px] leading-none text-muted">
                {tickers[i]}
              </span>
            )}
            {row.map((value, j) => {
              const isActive = cell?.[0] === i && cell?.[1] === j;
              const strong = Math.abs(value) >= 0.55;
              return (
                <span
                  key={tickers[j]}
                  onPointerEnter={() => setCell([i, j])}
                  onPointerDown={() => setCell([i, j])}
                  className={`flex aspect-square min-w-0 items-center justify-center overflow-hidden font-mono text-[9px] leading-none ${
                    strong ? "text-bg" : "text-fg"
                  } ${isActive ? "outline outline-2 -outline-offset-1 outline-fg" : ""}`}
                  style={{ background: i === j ? "var(--raised)" : fill(value) }}
                >
                  {numbered && i !== j && (
                    <span className="hidden min-[430px]:inline">{short(value)}</span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
        {labelled && (
          <div className="contents" aria-hidden>
            <span />
            {tickers.map((ticker) => (
              <span
                key={ticker}
                className="flex h-9 items-start justify-center pt-1 font-mono text-[10px] leading-none text-muted [writing-mode:vertical-rl]"
              >
                {ticker}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p role="status" className="min-h-4 font-mono text-[11px] text-muted">
          {active ? (
            <>
              <span className="text-fg">
                {active.a} / {active.b}
              </span>{" "}
              {active.a === active.b ? "same holding" : `correlation ${num(active.value)}`}
            </>
          ) : (
            "Hover or use arrow keys to read a pair."
          )}
        </p>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted" aria-hidden>
          <span>{"−"}1</span>
          <span
            className="h-2 w-24"
            style={{
              background:
                "linear-gradient(90deg in oklab, var(--div-neg), var(--div-mid), var(--div-pos))",
            }}
          />
          <span>+1</span>
        </div>
      </div>
      {highest && lowest && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Most alike: <span className="font-mono text-fg">{highest.a}</span> and{" "}
          <span className="font-mono text-fg">{highest.b}</span> ({num(highest.value)}). Least
          alike: <span className="font-mono text-fg">{lowest.a}</span> and{" "}
          <span className="font-mono text-fg">{lowest.b}</span> ({num(lowest.value)}).
        </p>
      )}
    </div>
  );
}
