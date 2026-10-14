import presetList from "@/fixtures/presets.json";
import sampleBundle from "@/fixtures/sample.json";
import { Dashboard } from "@/components/Dashboard";
import { Disclaimer } from "@/components/Disclaimer";
import { DemoBanner } from "@/components/kit/DemoBanner";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import { analystFixtures, analystPlaceholder } from "@/lib/analyst-route";
import { Preset, SampleBundle } from "@/lib/schema";

// Both files are written by server/scripts/export_demo.py. Parsing them here means a
// stale or hand-edited bundle fails the build instead of rendering wrong numbers.
const sample = SampleBundle.parse(sampleBundle);
const presets = Preset.array()
  .parse(presetList)
  .map((preset) => ({
    ...preset.body,
    // Each preset is labelled by its own fixture, so the wording stays right while
    // some sessions are recorded and others are still samples.
    placeholder: analystFixtures[preset.body.demoId]?.placeholder ?? true,
  }));

export default function Home() {
  return (
    <>
      <DemoBanner placeholder={analystPlaceholder} />
      <header className="flex items-center justify-between gap-4 border-b border-border px-3 py-2 sm:px-4">
        <p className="flex min-w-0 items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tracking-[0.22em] text-fg">
            DRAWDOWN
          </span>
          <span className="hidden truncate font-mono text-[11px] text-muted sm:inline">
            portfolio risk, explained
          </span>
        </p>
        <ThemeToggle />
      </header>
      <Disclaimer synthetic={sample.analysis.dataset.synthetic} />
      <Dashboard sample={sample} presets={presets} placeholder={analystPlaceholder} />
      <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
        Built with Claude Code and Claude Opus 5.5.
      </footer>
    </>
  );
}
