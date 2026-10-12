"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiMeta, ErrorKind } from "@/lib/api";
import { streamApi } from "@/lib/client";
import { RISK_API_URL, hasRiskApi } from "@/lib/risk-api";
import { AnalystEvent, Session } from "@/lib/schema";
import { EMPTY_TRAIL, applyEvent, type Trail } from "@/lib/session";
import { useKey } from "./kit/KeyProvider";

export interface AnalystRequest {
  /** Set for a preset: the id its bundled session is stored under. */
  demoId?: string;
  question: string;
}

export interface CustomPortfolio {
  holdings: { ticker: string; weight: number }[];
  totalValue: number;
}

export interface AnalystState {
  /** Counts runs, so the view can start each one with fresh selection state. */
  run: number;
  status: "idle" | "running" | "done" | "error" | "stopped";
  question: string | null;
  trail: Trail;
  session: Session | null;
  /** Where the stream came from, known as soon as its first frame arrives. */
  source: { mode: "live" | "demo"; placeholder: boolean } | null;
  meta: ApiMeta | null;
  error: { kind: ErrorKind; message: string } | null;
}

const IDLE: AnalystState = {
  run: 0,
  status: "idle",
  question: null,
  trail: EMPTY_TRAIL,
  session: null,
  source: null,
  meta: null,
  error: null,
};

const NEEDS_KEY =
  "Demo mode replays the preset questions on the sample portfolio. Add your Anthropic key to ask this live.";
const NEEDS_API =
  "This deployment is not connected to the risk engine API, so live runs are unavailable here. Remove your key to replay the bundled sessions, or run the project locally.";

/**
 * Runs one analyst session at a time. With a key the request goes to the Python risk
 * API and Claude; without one it replays a bundled session from this app's own route.
 * Both answer with the same event stream, so everything after `streamApi` is shared.
 */
export function useAnalyst(custom: CustomPortfolio | null) {
  const { apiKey } = useKey();
  const [state, setState] = useState<AnalystState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const runs = useRef(0);

  const stop = useCallback(() => {
    if (!controller.current) return;
    // Aborting closes the connection. The API notices and makes no further model calls.
    controller.current.abort();
    controller.current = null;
    setState((current) =>
      current.status === "running" ? { ...current, status: "stopped" } : current,
    );
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(IDLE);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(
    async (request: AnalystRequest) => {
      controller.current?.abort();
      const live = apiKey !== null;
      runs.current += 1;
      const base = { ...IDLE, run: runs.current, question: request.question };
      if (live && !hasRiskApi) {
        setState({ ...base, status: "error", error: { kind: "server", message: NEEDS_API } });
        return;
      }
      if (!live && (custom || !request.demoId)) {
        setState({ ...base, status: "error", error: { kind: "demo_miss", message: NEEDS_KEY } });
        return;
      }

      const abort = new AbortController();
      controller.current = abort;
      setState({ ...base, status: "running" });
      const current = () => controller.current === abort;

      const url = live ? `${RISK_API_URL}/api/analyst` : "/api/analyst";
      const body = live
        ? { question: request.question, ...(custom ?? {}) }
        : { demoId: request.demoId, question: request.question };

      const response = await streamApi<unknown, unknown>(
        url,
        body,
        live ? apiKey : null,
        {
          onMeta: (meta) => {
            if (current()) {
              setState((s) => ({
                ...s,
                source: { mode: meta.mode, placeholder: meta.placeholder },
              }));
            }
          },
          onEvent: (raw) => {
            const event = AnalystEvent.safeParse(raw);
            if (event.success && current()) {
              setState((s) => ({ ...s, trail: applyEvent(s.trail, event.data) }));
            }
          },
        },
        abort.signal,
      );
      if (!current()) return; // stopped, or replaced by a newer run
      controller.current = null;

      if (!response.ok) {
        const offline = live && response.error.message.startsWith("Network error");
        setState((s) => ({
          ...s,
          status: "error",
          meta: response.meta ?? null,
          error: offline
            ? {
                kind: "server",
                message:
                  "The risk engine API did not answer. It may be asleep or offline. No model call was made.",
              }
            : response.error,
        }));
        return;
      }
      const session = Session.safeParse(response.data);
      if (!session.success) {
        setState((s) => ({
          ...s,
          status: "error",
          meta: response.meta,
          error: { kind: "server", message: "The analyst's reply was not in the expected shape." },
        }));
        return;
      }
      setState((s) => ({
        ...s,
        status: "done",
        session: session.data,
        meta: response.meta,
        source: { mode: response.meta.mode, placeholder: response.meta.placeholder },
      }));
    },
    [apiKey, custom],
  );

  return { state, run, stop, reset };
}

export type Analyst = ReturnType<typeof useAnalyst>;
