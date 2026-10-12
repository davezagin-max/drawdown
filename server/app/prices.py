"""Loads the bundled price history (or a local file the user fetched for personal use)."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
BUNDLED = DATA_DIR / "prices.parquet"


@dataclass(frozen=True)
class PriceData:
    prices: pd.DataFrame  # index: date, one column per ticker
    meta: dict[str, object]

    @property
    def synthetic(self) -> bool:
        return self.meta.get("source") == "synthetic"


def _meta_path(path: Path) -> Path:
    return path.with_suffix(".meta.json")


@lru_cache(maxsize=2)
def _load(path: Path) -> PriceData:
    frame = pd.read_parquet(path)
    if "date" in frame.columns:
        frame = frame.set_index("date")
    frame.index = pd.to_datetime(frame.index)
    frame = frame.sort_index().astype("float64")
    meta_file = _meta_path(path)
    meta = json.loads(meta_file.read_text()) if meta_file.exists() else {"source": "unknown"}
    return PriceData(prices=frame, meta=meta)


def load_prices() -> PriceData:
    """The bundled simulated prices, unless DRAWDOWN_PRICES points at another Parquet file."""
    override = os.environ.get("DRAWDOWN_PRICES")
    return _load(Path(override).resolve() if override else BUNDLED)
