"""The opt-in real-price loader: parsing and alignment only. No test touches the network."""

import importlib.util
import json
from pathlib import Path

import pandas as pd
import pytest

from app import prices as price_store
from app.portfolio import Holding, Portfolio, analyze
from tests.helpers import TINY_PRICES

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "fetch_prices.py"
spec = importlib.util.spec_from_file_location("fetch_prices", SCRIPT)
assert spec and spec.loader
fetch_prices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_prices)


def csv(rows: int, start: str = "2024-01-01", price: float = 100.0) -> str:
    dates = pd.bdate_range(start, periods=rows)
    lines = [f"{d.date()},1,2,0.5,{price + i * 0.1:.2f},1000" for i, d in enumerate(dates)]
    return "Date,Open,High,Low,Close,Volume\n" + "\n".join(lines) + "\n"


def test_parse_reads_closing_prices_in_date_order() -> None:
    series = fetch_prices.parse_price_csv(csv(260))
    assert len(series) == 260
    assert series.index.is_monotonic_increasing
    assert series.iloc[0] == 100.0 and series.iloc[-1] == pytest.approx(125.9)


def test_parse_rejects_what_is_not_price_data() -> None:
    with pytest.raises(fetch_prices.FetchError, match="Date and Close"):
        fetch_prices.parse_price_csv("No data")
    with pytest.raises(fetch_prices.FetchError, match="Date and Close"):
        fetch_prices.parse_price_csv("<html><body>Rate limit</body></html>")
    with pytest.raises(fetch_prices.FetchError, match="only 10 usable rows"):
        fetch_prices.parse_price_csv(csv(10))


def test_parse_drops_bad_rows() -> None:
    text = csv(260) + "not-a-date,1,2,0.5,50,1\n2030-01-01,1,2,0.5,-5,1\n2030-01-02,1,2,0.5,,1\n"
    assert len(fetch_prices.parse_price_csv(text)) == 260


def test_combine_keeps_only_dates_every_ticker_has() -> None:
    a = fetch_prices.parse_price_csv(csv(300, "2024-01-01"))
    b = fetch_prices.parse_price_csv(csv(300, "2024-01-15"))  # starts ten sessions later
    frame = fetch_prices.combine({"A": a, "B": b}, rows=260)
    assert list(frame.columns) == ["A", "B"]
    assert len(frame) == 260
    assert not frame.isna().any().any()
    assert frame.index[-1] == a.index[-1]
    with pytest.raises(fetch_prices.FetchError, match="share only"):
        fetch_prices.combine({"A": a, "B": fetch_prices.parse_price_csv(csv(260, "2026-06-01"))})


def test_the_script_refuses_to_run_without_the_terms_flag(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def no_network(_: str) -> str:
        raise AssertionError("the script must not download anything without the flag")

    monkeypatch.setattr(fetch_prices, "download", no_network)
    monkeypatch.setattr("sys.argv", ["fetch_prices.py"])
    assert fetch_prices.main() == 1
    assert "--i-have-read-the-terms" in capsys.readouterr().out


def test_a_local_price_file_replaces_the_bundled_one_and_is_not_called_synthetic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "prices.parquet"
    frame = TINY_PRICES.copy()
    frame.index.name = "date"
    frame.reset_index().to_parquet(path, index=False)
    path.with_suffix(".meta.json").write_text(json.dumps({"source": "stooq"}))
    monkeypatch.setenv("DRAWDOWN_PRICES", str(path))

    data = price_store.load_prices()
    assert not data.synthetic
    assert list(data.prices.columns) == ["SPY", "AAPL", "TLT", "GLD"]
    bundle = analyze(Portfolio(data, [Holding("AAPL", 0.5), Holding("TLT", 0.5)], 1000.0))
    # The UI's "prices are simulated" line is driven by this flag, so it must turn off.
    assert bundle["dataset"] == {
        "source": "stooq",
        "synthetic": False,
        "start": "2024-01-01",
        "end": "2024-01-04",
        "tradingDays": 3,
    }

    monkeypatch.delenv("DRAWDOWN_PRICES")
    assert price_store.load_prices().synthetic
