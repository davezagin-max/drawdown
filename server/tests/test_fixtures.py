"""Every bundled fixture is something the real pipeline produces.

These tests re-run each stored tool call through the engine and each stored answer
through the provenance checker. They compare against each fixture's own `placeholder`
flag, so they keep passing after `scripts/record.py` replaces a placeholder with a
recorded run.
"""

import json
import math
from pathlib import Path
from typing import Any

import pytest

from app.analyst import build_session
from app.demo_sessions import SCRIPTS, build_placeholder, presets
from app.frontier import simulate_frontier
from app.portfolio import SAMPLE_TOTAL_VALUE, Portfolio, analyze, sample_holdings
from app.prices import load_prices
from app.schema import EventEnvelope, Session
from app.tools import build_handlers

SERVER = Path(__file__).resolve().parent.parent
REPO = SERVER.parent
STORE: dict[str, Any] = json.loads((SERVER / "fixtures" / "analyst.json").read_text())
PRESETS: list[dict[str, Any]] = json.loads((SERVER / "fixtures" / "presets.json").read_text())


def sample() -> Portfolio:
    return Portfolio(load_prices(), sample_holdings(), SAMPLE_TOTAL_VALUE)


def close(a: Any, b: Any, tolerance: float = 2e-6) -> bool:
    """Deep equality with a little slack on floats (math libraries differ in the last bit)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=tolerance)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k], tolerance) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y, tolerance) for x, y in zip(a, b, strict=True))
    return a == b


def test_close_helper_is_strict_about_shape() -> None:
    assert close({"a": [1.0, 2.0]}, {"a": [1.0000001, 2.0]})
    assert not close({"a": [1.0, 2.0]}, {"a": [1.1, 2.0]})
    assert not close({"a": 1}, {"b": 1})
    assert not close([1, 2], [1, 2, 3])
    assert not close(True, 1)


def test_there_is_a_fixture_for_every_preset_and_nothing_else() -> None:
    assert [p["body"]["demoId"] for p in PRESETS] == list(SCRIPTS)
    assert sorted(STORE) == sorted(SCRIPTS)
    assert presets() == PRESETS
    for preset in PRESETS:
        assert preset["route"] == "/api/analyst"
        assert STORE[preset["body"]["demoId"]]["data"]["question"] == preset["body"]["question"]


@pytest.mark.parametrize("demo_id", sorted(STORE))
def test_fixture_is_a_valid_output_of_the_real_pipeline(demo_id: str) -> None:
    fixture = STORE[demo_id]
    session = Session.model_validate(fixture["data"])
    data = fixture["data"]

    # 1. Every stored tool output is what the engine returns for those inputs today.
    handlers = build_handlers(sample())
    for call in data["calls"]:
        if call["isError"]:
            with pytest.raises(ValueError):
                handlers[call["name"]](call["input"])
        else:
            assert close(handlers[call["name"]](call["input"]), call["output"]), call["id"]

    # 2. The stored verdict is what the checker says about the stored answer today.
    rebuilt = build_session(data["question"], data["answer"], data["calls"], data["rounds"])
    assert close(rebuilt, data)
    assert "".join(s.text for s in session.provenance.segments) == session.answer

    # 3. The streamed events are well-formed and agree with the final session.
    events = [EventEnvelope.model_validate({"event": e["event"]}).event for e in fixture["events"]]
    offsets = [e["at"] for e in fixture["events"]]
    assert offsets == sorted(offsets) and offsets[0] >= 0
    streamed = [e.call.model_dump() for e in events if e.type == "tool"]
    assert close(streamed, data["calls"])
    assert events[0].type == "round"
    # Calls in the same round were requested together: that is the parallel tool use.
    assert max(c.round for c in session.calls) <= session.rounds

    # 4. Labelling is honest: a placeholder has no usage, a recording has a timestamp.
    if fixture["placeholder"]:
        assert fixture["recordedAt"] is None
        assert fixture["costUsd"] == 0
        assert set(fixture["usage"].values()) == {0}
        assert close(build_placeholder(demo_id, sample()), fixture)  # nothing edited by hand
        # A placeholder narration has no excuse for an unverified figure.
        assert session.provenance.unmatched == 0
        assert session.provenance.matched >= 10
        assert session.usedTools
    else:
        assert fixture["recordedAt"] is not None
        assert fixture["costUsd"] > 0


@pytest.mark.parametrize("demo_id", sorted(STORE))
def test_placeholder_sessions_demonstrate_the_features_the_demo_claims(demo_id: str) -> None:
    fixture = STORE[demo_id]
    if not fixture["placeholder"]:
        pytest.skip("recorded run: its shape is up to the model")
    calls = fixture["data"]["calls"]
    per_round: dict[int, int] = {}
    for call in calls:
        per_round[call["round"]] = per_round.get(call["round"], 0) + 1
    assert max(per_round.values()) >= 2  # at least one round of parallel tool calls
    assert any(e["event"]["type"] == "note" for e in fixture["events"])
    self_test = fixture["data"]["selfTest"]
    assert self_test is not None
    assert self_test["provenance"]["unmatched"] == 1
    assert self_test["original"] in fixture["data"]["answer"]
    assert self_test["altered"] in self_test["answer"]


def test_placeholder_sessions_together_exercise_all_four_tools() -> None:
    used = {call["name"] for fixture in STORE.values() for call in fixture["data"]["calls"]}
    if all(fixture["placeholder"] for fixture in STORE.values()):
        assert used == {"get_metric", "run_stress_test", "rebalance_to_target", "monte_carlo"}


def test_no_session_tells_the_visitor_what_to_trade() -> None:
    for fixture in STORE.values():
        if fixture["placeholder"]:
            text = fixture["data"]["answer"].lower()
            for phrase in ("you should", "we recommend", "i recommend", "buy ", "sell "):
                assert phrase not in text


def test_frontend_copies_match_the_server_fixtures() -> None:
    for name in ("analyst.json", "presets.json"):
        assert (REPO / "fixtures" / name).read_text() == (SERVER / "fixtures" / name).read_text()


def test_bundled_sample_analysis_is_what_the_engine_computes() -> None:
    bundle = json.loads((REPO / "fixtures" / "sample.json").read_text())
    assert close(bundle["analysis"], analyze(sample()), tolerance=2e-4)
    assert len(bundle["universe"]) == 52
    assert bundle["limits"] == {
        "maxCsvBytes": 32_000,
        "maxHoldings": 50,
        "minHoldings": 2,
        "maxQuestionChars": 500,
    }


def test_bundled_frontier_is_what_the_engine_simulates() -> None:
    stored = json.loads((REPO / "fixtures" / "frontier.json").read_text())
    assert stored["count"] == len(stored["points"]) == 3000
    assert close(stored, simulate_frontier(sample()), tolerance=2e-4)


def test_sample_csv_is_the_sample_portfolio() -> None:
    from app.portfolio import parse_holdings_csv

    holdings, total, assumed = parse_holdings_csv(
        (REPO / "public" / "sample-holdings.csv").read_text()
    )
    assert (total, assumed) == (SAMPLE_TOTAL_VALUE, False)
    assert [(h.ticker, round(h.weight, 6)) for h in holdings] == [
        (h.ticker, round(h.weight, 6)) for h in sample_holdings()
    ]
