/**
 * Demo replay for the analyst panel.
 *
 * The analyst itself lives in the Python risk API (server/app/analyst.py), next to
 * the engine its tools call. This route only replays the bundled sessions, so the
 * deployed demo works with that API switched off. Both servers write the same
 * server-sent-event frames, which is why the browser reads either one with the
 * same `streamApi` call.
 */
import { z } from "zod";
import fixtures from "@/fixtures/analyst.json";
import { streamRoute } from "@/lib/api";
import { PipelineError } from "@/lib/claude";
import type { FixtureStore } from "@/lib/demo";
import type { AnalystEvent, Session } from "@/lib/schema";

const Body = z.object({
  demoId: z.string().max(64).optional(),
  question: z.string().max(500).optional(),
});

export const analystFixtures = fixtures as unknown as FixtureStore<Session, AnalystEvent>;

/** True while any bundled session is a hand-written sample rather than a recorded run. */
export const analystPlaceholder = Object.values(analystFixtures).some((f) => f.placeholder);

export function analystRoute(replaySpeed = 3) {
  return streamRoute({
    store: "analyst",
    fixtures: analystFixtures,
    schema: Body,
    replaySpeed,
    live: async () => {
      // The browser sends live runs straight to the risk API; a key should never arrive here.
      throw new PipelineError(
        "Live analyst runs go to the risk engine API, not to this route. This route only replays the bundled sessions.",
        400,
      );
    },
  });
}
