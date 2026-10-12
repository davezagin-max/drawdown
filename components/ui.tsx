import type { ReactNode } from "react";

/** A titled panel: hairline border, tight padding, a mono caps label. */
export function Card({
  id,
  title,
  note,
  aside,
  children,
  className = "",
  fill = false,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Let the body stretch, so a chart inside can take up whatever height the card is given. */
  fill?: boolean;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`min-w-0 border border-border bg-surface ${fill ? "flex flex-col" : ""} ${className}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        <h2
          id={`${id}-title`}
          className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg"
        >
          {title}
        </h2>
        {aside && <div className="font-mono text-[11px] text-muted">{aside}</div>}
      </header>
      <div className={`p-3 ${fill ? "flex flex-1 flex-col" : ""}`}>
        {children}
        {note && <p className="mt-3 text-xs leading-relaxed text-muted">{note}</p>}
      </div>
    </section>
  );
}

/** A short stroke of a series color, used in legends and tooltips. */
export function LineKey({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block h-0.5 w-4 shrink-0 align-middle"
      style={{
        background: dashed
          ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
          : color,
      }}
    />
  );
}
