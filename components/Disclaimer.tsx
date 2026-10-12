/**
 * Persistent on every screen: it sticks to the top of the viewport while the page
 * scrolls. The second sentence follows the dataset, so it stays true if someone runs
 * the engine on prices they fetched themselves.
 */
export function Disclaimer({ synthetic }: { synthetic: boolean }) {
  return (
    <div
      role="note"
      className="sticky top-0 z-30 border-b border-border bg-accent-soft px-3 py-1.5 text-center text-xs leading-snug text-fg sm:px-4"
    >
      <strong className="font-semibold">Educational only. Not financial advice.</strong>{" "}
      {synthetic
        ? "Prices are simulated for demonstration; tickers and sectors are labels only."
        : "Figures describe historical prices and are not a forecast."}
    </div>
  );
}
