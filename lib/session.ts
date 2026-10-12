/**
 * Folds the analyst's streamed events into what the panel shows: one block per
 * round, each with the model's progress notes and the tool calls it requested
 * together. Pure functions, so replay and live runs behave identically.
 */
import type { AnalystEvent, ToolCall } from "./schema";

export interface RoundView {
  round: number;
  notes: string[];
  calls: ToolCall[];
}

export interface Trail {
  rounds: RoundView[];
  /** The model first answered without tools and was asked again. */
  retried: boolean;
}

export const EMPTY_TRAIL: Trail = { rounds: [], retried: false };

function withRound(trail: Trail, round: number, change: (view: RoundView) => RoundView): Trail {
  const existing = trail.rounds.find((view) => view.round === round);
  const rounds = existing
    ? trail.rounds.map((view) => (view === existing ? change(view) : view))
    : [...trail.rounds, change({ round, notes: [], calls: [] })];
  return { ...trail, rounds };
}

export function applyEvent(trail: Trail, event: AnalystEvent): Trail {
  switch (event.type) {
    case "round":
      return withRound(trail, event.round, (view) => view);
    case "note": {
      // A note belongs to the round in progress (the last one announced).
      const current = trail.rounds.at(-1)?.round ?? 1;
      return withRound(trail, current, (view) => ({ ...view, notes: [...view.notes, event.text] }));
    }
    case "tool":
      return withRound(trail, event.call.round, (view) => ({
        ...view,
        calls: [...view.calls, event.call],
      }));
    case "retry":
      // The first attempt used no tools, so there is no trail worth keeping.
      return { rounds: [], retried: true };
  }
}

export function allCalls(trail: Trail): ToolCall[] {
  return trail.rounds.flatMap((view) => view.calls);
}

function show(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** `get_metric(volatility, PORTFOLIO)`: the call as a reader would write it. */
export function callSignature(call: ToolCall): string {
  return `${call.name}(${Object.values(call.input).map(show).join(", ")})`;
}

function field(output: unknown, key: string): unknown {
  return output && typeof output === "object"
    ? (output as Record<string, unknown>)[key]
    : undefined;
}

/** The one result a reader most wants from a call, as `label value` pairs. */
export function callHeadline(call: ToolCall): { label: string; value: number }[] {
  if (call.isError) return [];
  const pick = (label: string, ...path: string[]) => {
    const value = path.reduce<unknown>((node, key) => field(node, key), call.output);
    return typeof value === "number" ? [{ label, value }] : [];
  };
  switch (call.name) {
    case "get_metric":
      return [...pick("value", "value"), ...pick("count", "count")];
    case "run_stress_test":
      return [
        ...pick("portfolio_change", "portfolio_change"),
        ...pick("usd", "portfolio_change_usd"),
      ];
    case "rebalance_to_target":
      return [
        ...pick("volatility before", "before", "volatility"),
        ...pick("after", "after", "volatility"),
      ];
    case "monte_carlo":
      return [
        ...pick("median return", "return_percentiles", "p50"),
        ...pick("probability_of_loss", "probability_of_loss"),
      ];
  }
}
