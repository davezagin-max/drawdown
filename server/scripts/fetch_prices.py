"""Load real daily prices for your own personal use. Nothing here is run by the app.

    uv run python scripts/fetch_prices.py
    DRAWDOWN_PRICES=data/local/prices.parquet uv run uvicorn app.main:app --port 8300

Read this before running it

- The repository ships SIMULATED prices on purpose. Free market-data providers generally
  do not allow their data to be redistributed, so real prices must not be committed to a
  public repository or served from a public deployment.
- This script writes to data/local/, which is gitignored. Keep it there.
- You are responsible for reading and following the terms of the provider you point it
  at. The default URL is Stooq's daily CSV download. This script was written without a
  network connection to that service: the endpoint and its terms have not been verified
  here, so check both yourself first. `--url-template` lets you use another provider
  that serves a CSV with a date column and a close column.
- It makes one request per ticker, a second apart, and stops on the first failure.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.synthetic import TRADING_DAYS  # noqa: E402
from app.universe import TICKERS  # noqa: E402

DEFAULT_URL = "https://stooq.com/q/d/l/?s={symbol}.us&i=d"
OUTPUT = ROOT / "data" / "local" / "prices.parquet"
MIN_ROWS = 253  # one year of returns: anything shorter is not worth analysing


class FetchError(Exception):
    pass


def parse_price_csv(text: str) -> pd.Series:
    """Closing prices by date from a CSV with `Date` and `Close` columns (any case)."""
    try:
        frame = pd.read_csv(io.StringIO(text))
    except Exception as error:
        raise FetchError("the response is not a CSV file") from error
    columns = {str(name).strip().lower(): name for name in frame.columns}
    if "date" not in columns or "close" not in columns:
        raise FetchError("the CSV has no Date and Close columns (was the symbol found?)")
    dates = pd.to_datetime(frame[columns["date"]], errors="coerce")
    close = pd.to_numeric(frame[columns["close"]], errors="coerce")
    series = pd.Series(close.to_numpy(), index=dates, name="close")
    series = series[series.index.notna() & series.notna() & (series > 0)]
    series = series[~series.index.duplicated(keep="last")].sort_index()
    if len(series) < MIN_ROWS:
        raise FetchError(f"only {len(series)} usable rows; at least {MIN_ROWS} are needed")
    return series


def combine(prices: dict[str, pd.Series], rows: int = TRADING_DAYS + 1) -> pd.DataFrame:
    """One column per ticker over the dates every ticker has, keeping the latest `rows`."""
    frame = pd.DataFrame(prices).dropna(how="any").sort_index().tail(rows)
    if len(frame) < MIN_ROWS:
        raise FetchError(
            f"the tickers share only {len(frame)} dates; at least {MIN_ROWS} are needed"
        )
    frame.index.name = "date"
    return frame


def download(url: str) -> str:
    request = urllib.request.Request(url, headers={"user-agent": "drawdown-fetch/1 (personal use)"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url-template", default=DEFAULT_URL, help="must contain {symbol}")
    parser.add_argument("--source-name", default="stooq", help="recorded in the metadata file")
    parser.add_argument(
        "--i-have-read-the-terms",
        action="store_true",
        help="confirm you have read the provider's terms and will not redistribute the data",
    )
    args = parser.parse_args()
    if not args.i_have_read_the_terms:
        print(__doc__)
        print("Re-run with --i-have-read-the-terms once you have checked the provider's terms.")
        return 1
    if "{symbol}" not in args.url_template:
        print("--url-template must contain {symbol}.", file=sys.stderr)
        return 1

    prices: dict[str, pd.Series] = {}
    for ticker in TICKERS:
        try:
            prices[ticker] = parse_price_csv(
                download(args.url_template.format(symbol=ticker.lower()))
            )
        except (FetchError, OSError) as error:
            print(f"{ticker}: {error}. Nothing was written.", file=sys.stderr)
            return 1
        print(f"{ticker}: {len(prices[ticker])} rows")
        time.sleep(1.0)

    frame = combine(prices)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frame.reset_index().to_parquet(OUTPUT, index=False, compression="zstd")
    meta = {
        "source": args.source_name,
        "note": "Fetched for personal use. Do not commit or redistribute.",
        "start": frame.index[0].date().isoformat(),
        "end": frame.index[-1].date().isoformat(),
        "rows": len(frame),
        "tickers": len(frame.columns),
    }
    OUTPUT.with_suffix(".meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUTPUT}. Start the API with DRAWDOWN_PRICES={OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
