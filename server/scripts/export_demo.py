"""Precompute everything the frontend shows in demo mode, from the real engine.

    uv run python scripts/export_demo.py

Writes, for the sample portfolio:

- ../fixtures/sample.json     the analysis bundle, the ticker universe, and input limits
- ../fixtures/frontier.json   the simulated frontier cloud (loaded lazily by the 3D view)
- fixtures/analyst.json       the analyst sessions, mirrored to ../fixtures/analyst.json
- fixtures/presets.json       the preset requests, mirrored to ../fixtures/presets.json
- ../public/sample-holdings.csv

The Next.js app bundles the files under ../fixtures, so the deployed demo works with the
Python API switched off. A session that `scripts/record.py` has recorded is kept (its
figures are re-checked with the current provenance checker); the rest are rebuilt as
placeholders.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))

from app.analyst import MAX_QUESTION_CHARS, build_session  # noqa: E402
from app.demo_sessions import SCRIPTS, build_placeholder, presets  # noqa: E402
from app.frontier import simulate_frontier  # noqa: E402
from app.portfolio import (  # noqa: E402
    MAX_CSV_BYTES,
    MAX_HOLDINGS,
    MIN_HOLDINGS,
    SAMPLE_TOTAL_VALUE,
    SAMPLE_WEIGHTS,
    Portfolio,
    analyze,
    sample_holdings,
)
from app.prices import load_prices  # noqa: E402
from app.universe import UNIVERSE  # noqa: E402


def sample_portfolio() -> Portfolio:
    return Portfolio(load_prices(), sample_holdings(), SAMPLE_TOTAL_VALUE)


def sample_bundle(portfolio: Portfolio) -> dict[str, Any]:
    return {
        "analysis": analyze(portfolio),
        "universe": [
            {"ticker": s.ticker, "name": s.name, "sector": s.sector} for s in UNIVERSE.values()
        ],
        "limits": {
            "maxCsvBytes": MAX_CSV_BYTES,
            "maxHoldings": MAX_HOLDINGS,
            "minHoldings": MIN_HOLDINGS,
            "maxQuestionChars": MAX_QUESTION_CHARS,
        },
    }


def analyst_store(portfolio: Portfolio, existing: dict[str, Any]) -> dict[str, Any]:
    """Recorded sessions are kept and re-checked; everything else is a fresh placeholder."""
    store: dict[str, Any] = {}
    for demo_id in SCRIPTS:
        current = existing.get(demo_id)
        if current and not current.get("placeholder", True):
            data = current["data"]
            current["data"] = build_session(
                data["question"], data["answer"], data["calls"], data["rounds"]
            )
            store[demo_id] = current
        else:
            store[demo_id] = build_placeholder(demo_id, portfolio)
    return dict(sorted(store.items()))


def sample_csv() -> str:
    rows = [
        f"{ticker},{weight * SAMPLE_TOTAL_VALUE:.0f}" for ticker, weight in SAMPLE_WEIGHTS.items()
    ]
    return "ticker,value\n" + "\n".join(rows) + "\n"


def write(path: Path, payload: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, separators=(",", ":")) if compact else json.dumps(payload, indent=1)
    path.write_text(text + "\n")
    print(f"wrote {path.relative_to(REPO)} ({path.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    portfolio = sample_portfolio()
    store_path = ROOT / "fixtures" / "analyst.json"
    existing = json.loads(store_path.read_text()) if store_path.exists() else {}
    store = analyst_store(portfolio, existing)

    write(REPO / "fixtures" / "sample.json", sample_bundle(portfolio), compact=True)
    write(REPO / "fixtures" / "frontier.json", simulate_frontier(portfolio), compact=True)
    for folder in (ROOT / "fixtures", REPO / "fixtures"):
        write(folder / "analyst.json", store)
        write(folder / "presets.json", presets())
    csv_path = REPO / "public" / "sample-holdings.csv"
    csv_path.write_text(sample_csv())
    print(f"wrote {csv_path.relative_to(REPO)}")
    placeholders = sum(1 for fixture in store.values() if fixture["placeholder"])
    print(f"{len(store)} analyst sessions, {placeholders} of them placeholders")


if __name__ == "__main__":
    main()
