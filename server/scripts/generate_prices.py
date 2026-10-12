"""Write the simulated price history to data/prices.parquet.

    uv run python scripts/generate_prices.py

The output is committed, so this only needs to run when the model in app/synthetic.py
changes. Afterwards re-run scripts/export_demo.py so the frontend's bundled numbers match.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.prices import BUNDLED  # noqa: E402
from app.synthetic import SEED, generate_prices  # noqa: E402


def main() -> None:
    prices = generate_prices()
    BUNDLED.parent.mkdir(parents=True, exist_ok=True)
    prices.reset_index().to_parquet(BUNDLED, index=False, compression="zstd")
    meta = {
        "source": "synthetic",
        "note": (
            "Simulated by a seeded factor model. Ticker symbols and sectors are labels only; "
            "these are not real market prices."
        ),
        "generator": "server/app/synthetic.py",
        "seed": SEED,
        "start": prices.index[0].date().isoformat(),
        "end": prices.index[-1].date().isoformat(),
        "rows": len(prices),
        "tickers": len(prices.columns),
    }
    BUNDLED.with_suffix(".meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {BUNDLED} ({BUNDLED.stat().st_size / 1024:.0f} KB): {meta}")


if __name__ == "__main__":
    main()
