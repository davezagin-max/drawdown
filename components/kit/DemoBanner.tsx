"use client";

import { useKey } from "./KeyProvider";

interface DemoBannerProps {
  /**
   * True while the fixtures are hand-written samples rather than recorded
   * model runs. The banner says so plainly instead of implying a real run.
   */
  placeholder?: boolean;
  /** Set to false for projects whose core features need no key at all. */
  aiRequired?: boolean;
}

export function DemoBanner({ placeholder = false, aiRequired = true }: DemoBannerProps) {
  const { isLive, openKeyModal } = useKey();

  if (isLive) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-bg px-4 py-1.5 text-xs">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 rounded-full bg-success" />
          Live — calling Claude Opus 5.5 with your key.
        </span>
        <button type="button" onClick={openKeyModal} className="underline underline-offset-2">
          Change key
        </button>
      </div>
    );
  }

  // One calm line: honest about what is pre-written, without reading like an error.
  const message = !aiRequired
    ? "Everything here works without a key. Add one to turn on the Claude Opus 5.5 features."
    : placeholder
      ? "Demo: the AI analyst's answers here are pre-written examples. Add your Anthropic API key to run it live."
      : "Demo: replaying recorded Claude Opus 5.5 sessions. Add your Anthropic API key to run it live.";

  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 border-b border-border bg-bg px-4 py-1.5 text-center text-xs text-muted"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={openKeyModal}
        className="text-fg underline decoration-border underline-offset-2 hover:decoration-fg"
      >
        Add key
      </button>
    </div>
  );
}
