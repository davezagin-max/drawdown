/**
 * One plain-English line that says what the analyst session is doing right now, for a
 * reader who has never heard of a tool call. Derived only from the streamed trail and
 * the finished session, so a replay and a live run are narrated the same way. A tool
 * call is called a "calculation" here: it is one request to the risk engine, and it can
 * return several numbers.
 */
import type { Provenance, Session } from "./schema";
import type { Trail } from "./session";

export interface NarrationInput {
  status: "idle" | "running" | "done" | "error" | "stopped";
  trail: Trail;
  session: Session | null;
  /** The verdict on screen, when it differs from the session's own (the self-test). */
  shown?: Provenance;
  live: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function narrate({ status, trail, session, shown, live }: NarrationInput): string | null {
  // An error or a stop already has its own message in the panel.
  if (status === "idle" || status === "error" || status === "stopped") return null;

  if (status === "done") {
    if (!session) return null;
    if (!session.usedTools) {
      return "Done, but the analyst used no tools, so none of its numbers can be checked.";
    }
    const { numbers, matched, fromQuestion, unmatched } = shown ?? session.provenance;
    const engine = `the risk engine's ${plural(session.calls.length, "calculation")}`;
    if (numbers.length === 0) return "Done. The answer quotes no numbers to check.";
    if (unmatched > 0) {
      return `Done. Code checked the ${plural(numbers.length, "number")} in the answer: ${unmatched} ${unmatched === 1 ? "does" : "do"} not trace back to the risk engine and ${unmatched === 1 ? "is" : "are"} flagged in red.`;
    }
    if (fromQuestion > 0) {
      return `Done. Code checked the ${plural(numbers.length, "number")} in the answer: ${matched} trace back to ${engine}, and ${fromQuestion} ${fromQuestion === 1 ? "restates" : "restate"} the question.`;
    }
    return `Done. Code checked all ${plural(numbers.length, "number")} in the answer, and every one traces back to ${engine}.`;
  }

  // Running.
  const rounds = trail.rounds;
  const last = rounds.at(-1);
  if (!last) {
    if (trail.retried) {
      return "The first answer used no tools, so it was thrown away and the question asked again.";
    }
    return live ? "Sending the question to Claude…" : "Starting the sample session…";
  }
  const earlier = rounds.slice(0, -1).flatMap((round) => round.calls);
  if (last.calls.length > 0) {
    const n = last.calls.length;
    const asked =
      earlier.length === 0
        ? `the risk engine for ${plural(n, "calculation")}`
        : `for ${n} more ${n === 1 ? "calculation" : "calculations"}`;
    return `The analyst asks ${asked}${n > 1 ? " at once" : ""}. Code runs each one.`;
  }
  if (earlier.length === 0) {
    return "The analyst reads the question and decides what to ask the risk engine to calculate. It has no numbers yet.";
  }
  const previous = rounds.at(-2)?.calls.length ?? 0;
  const sofar = earlier.length > previous ? ` (${earlier.length} in all)` : "";
  return `Code returned ${plural(previous, "result")}${sofar}. The analyst reads them and decides whether to ask for more or write the answer…`;
}
