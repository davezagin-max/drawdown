import asyncio
import json
import threading
from typing import Any

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app import demo, risk
from app.http import Live, RateLimiter, get_client, respond_stream
from app.main import analyst_limit, app
from app.portfolio import Portfolio, normalize
from app.prices import load_prices
from app.schema import Session
from tests.fakes import FakeClient, block, message

client = TestClient(app)
CSV = "ticker,value\nAAPL,6000\nKO,3000\nTLT,1000\n"


@pytest.fixture(autouse=True)
def demo_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """No server key, no recording, and no waiting while a fixture replays."""
    monkeypatch.delenv("ALLOW_SERVER_KEY", raising=False)
    monkeypatch.delenv("RECORD_FIXTURES", raising=False)
    monkeypatch.setattr("app.http.time.sleep", lambda _: None)
    app.dependency_overrides.clear()


def frames(response: Any) -> list[dict[str, Any]]:
    return [json.loads(c.removeprefix("data: ")) for c in response.text.split("\n\n") if c]


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


# --- /api/portfolio -----------------------------------------------------------------


def test_portfolio_analyses_uploaded_holdings_without_a_key() -> None:
    res = client.post("/api/portfolio", json={"csv": CSV})
    body = res.json()
    assert res.status_code == 200 and body["ok"] is True
    assert body["meta"]["model"] == "none" and body["meta"]["costUsd"] == 0
    analysis = body["data"]["analysis"]
    assert [h["ticker"] for h in analysis["holdings"]] == ["AAPL", "KO", "TLT"]
    assert analysis["totalValue"] == 10_000.0 and analysis["valueAssumed"] is False
    assert analysis["dataset"]["synthetic"] is True
    assert 0 < analysis["metrics"]["volatility"] < 1
    assert body["data"]["frontier"]["count"] == 3000


def test_portfolio_explains_bad_holdings() -> None:
    res = client.post("/api/portfolio", json={"csv": "ticker,value\nAAPL,5\nZZZZ,5\n"})
    assert res.status_code == 400
    assert res.json()["error"]["kind"] == "invalid"
    assert "ZZZZ" in res.json()["error"]["message"]


def test_portfolio_never_echoes_markup_from_a_file() -> None:
    res = client.post("/api/portfolio", json={"csv": "ticker,value\n<img src=x>,5\nAAPL,5\n"})
    assert res.status_code == 400
    assert "<img" not in res.text


def test_portfolio_caps_the_upload() -> None:
    too_long = "ticker,value\n" + "AAPL,1\n" * 5000  # about 40 KB: over the 32 KB file limit
    res = client.post("/api/portfolio", json={"csv": too_long})
    assert res.status_code == 400
    assert res.json()["error"] == {
        "kind": "invalid",
        "message": "The file is too large (limit 32 KB).",
    }
    huge = b'{"csv":"' + b"a" * 70_000 + b'"}'  # over the 64 KB body limit
    res = client.post("/api/portfolio", content=huge)
    assert res.status_code == 413
    assert res.json()["error"]["kind"] == "too_large"


def test_portfolio_explains_a_body_without_a_csv_field() -> None:
    res = client.post("/api/portfolio", json={"holdings": CSV})
    assert res.status_code == 400
    assert res.json()["error"] == {
        "kind": "invalid",
        "message": "Request body has an invalid shape.",
    }


# --- /api/analyst in demo mode ------------------------------------------------------


def test_demo_mode_replays_a_preset_session_without_a_key() -> None:
    fixture = demo.find_fixture("analyst", "risk-sources")
    assert fixture is not None
    res = client.post("/api/analyst", json={"demoId": "risk-sources", "question": "x"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    received = frames(res)
    assert received[0]["type"] == "meta" and received[0]["meta"]["mode"] == "demo"
    assert received[0]["meta"]["placeholder"] is fixture["placeholder"]
    assert [f["event"] for f in received[1:-1]] == [e["event"] for e in fixture["events"]]
    done = received[-1]
    assert done["type"] == "done"
    assert done["meta"]["placeholder"] is fixture["placeholder"]
    session = Session.model_validate(done["data"])
    assert session.provenance.matched > 0


def test_demo_miss_is_explained() -> None:
    res = client.post("/api/analyst", json={"question": "something unrecorded"})
    assert res.status_code == 404
    assert res.json()["error"]["kind"] == "demo_miss"


def test_a_preset_is_never_replayed_for_someone_elses_holdings() -> None:
    res = client.post(
        "/api/analyst",
        json={
            "demoId": "risk-sources",
            "question": "x",
            "holdings": [{"ticker": "AAPL", "weight": 1}, {"ticker": "KO", "weight": 1}],
        },
    )
    assert res.status_code == 404
    assert res.json()["error"]["kind"] == "demo_miss"


def test_analyst_refuses_an_oversized_body_before_reading_it() -> None:
    huge = b'{"demoId":"risk-sources","question":"' + b"q" * 70_000 + b'"}'
    res = client.post("/api/analyst", content=huge)
    assert res.status_code == 413
    assert res.json()["error"]["kind"] == "too_large"


def test_rate_limit_answers_with_the_error_envelope() -> None:
    app.dependency_overrides[analyst_limit] = RateLimiter(limit=1, window_seconds=60)
    body = {"demoId": "risk-sources", "question": "Where is the risk coming from?"}
    assert client.post("/api/analyst", json=body).status_code == 200
    res = client.post("/api/analyst", json=body)
    assert res.status_code == 429
    assert res.json()["error"] == {
        "kind": "rate_limit",
        "message": "Too many requests. Wait a moment.",
    }


def test_malformed_key_is_rejected_and_not_echoed() -> None:
    res = client.post(
        "/api/analyst", json={"question": "x"}, headers={"x-anthropic-key": "definitely-not-a-key"}
    )
    assert res.status_code == 401
    assert res.json()["error"]["kind"] == "auth"
    assert "definitely-not-a-key" not in res.text


def test_analyst_validates_the_request() -> None:
    assert client.post("/api/analyst", json={"question": ""}).status_code == 400
    assert client.post("/api/analyst", json={"question": "a" * 501}).status_code == 400
    bad = client.post(
        "/api/analyst",
        json={"question": "x", "holdings": [{"ticker": "ZZZZ", "weight": 1}]},
    )
    assert bad.status_code == 400 and "ZZZZ" in bad.json()["error"]["message"]


# --- /api/analyst live, with a fake client -------------------------------------------


def test_live_session_streams_events_then_the_verified_answer() -> None:
    # What the engine says the beta of a 60/40 AAPL/KO mix is, worked out independently.
    book = Portfolio(load_prices(), normalize({"AAPL": 6.0, "KO": 4.0}), 50_000)
    beta = risk.beta(book.returns, book.market)
    fake = FakeClient(
        [
            message(
                [
                    block("thinking", thinking="Checking beta.", signature="s"),
                    block(
                        "tool_use",
                        id="t1",
                        name="get_metric",
                        input={"metric": "beta", "subject": "PORTFOLIO"},
                    ),
                ],
                "tool_use",
            ),
            message([block("text", text=f"Beta is {beta:.2f}, and I would guess 9% volatility.")]),
        ]
    )
    app.dependency_overrides[get_client] = lambda: fake
    res = client.post(
        "/api/analyst",
        json={
            "question": "What is my beta?",
            "holdings": [{"ticker": "aapl", "weight": 6}, {"ticker": "KO", "weight": 4}],
            "totalValue": 50_000,
        },
    )
    received = frames(res)
    assert [f["type"] for f in received] == ["meta", "event", "event", "event", "event", "done"]
    assert received[0]["meta"] == {"mode": "live", "placeholder": False, "recordedAt": None}
    assert [f["event"]["type"] for f in received[1:-1]] == ["round", "note", "tool", "round"]
    done = received[-1]
    assert done["meta"]["mode"] == "live" and done["meta"]["costUsd"] > 0
    session = Session.model_validate(done["data"])
    assert session.calls[0].output["value"] == pytest.approx(beta, abs=1e-6)
    assert 0.5 < beta < 1.2  # the visitor's own holdings were analysed, not the sample
    assert [(n.text, n.status) for n in session.provenance.numbers] == [
        (f"{beta:.2f}", "matched"),
        ("9%", "unmatched"),
    ]
    assert "AAPL (Technology), KO (Consumer Staples)" in fake.requests[0]["messages"][0]["content"]


def test_live_refusal_is_a_clear_error_frame() -> None:
    details = block("refusal", category="financial_advice", explanation="no")
    app.dependency_overrides[get_client] = lambda: FakeClient(
        [message([], "refusal", stop_details=details)]
    )
    received = frames(client.post("/api/analyst", json={"question": "Which stock should I buy?"}))
    assert received[-1]["type"] == "error"
    assert received[-1]["error"]["kind"] == "refusal"
    assert "declined" in received[-1]["error"]["message"]


def test_live_pipeline_error_reaches_the_visitor_in_plain_words() -> None:
    app.dependency_overrides[get_client] = lambda: FakeClient(
        [message([block("text", text="Vol")], "max_tokens")]
    )
    received = frames(client.post("/api/analyst", json={"question": "How risky?"}))
    assert received[-1]["type"] == "error"
    assert "cut off" in received[-1]["error"]["message"]


# --- kit behaviour ------------------------------------------------------------------


def test_rate_limiter_blocks_after_the_limit() -> None:
    limiter = RateLimiter(limit=2, window_seconds=1)
    assert limiter.check("ip", now=0.0)
    assert limiter.check("ip", now=0.1)
    assert not limiter.check("ip", now=0.2)
    assert limiter.check("other", now=0.2)
    assert limiter.check("ip", now=1.5)


def test_request_key_prefers_a_safe_demo_id() -> None:
    assert demo.request_key({"demoId": "preset-1", "x": 1}) == "preset-1"
    unsafe = demo.request_key({"demoId": "../../etc/passwd"})
    assert unsafe != "../../etc/passwd" and len(unsafe) == 16
    assert demo.request_key({"a": 1, "b": 2}) == demo.request_key({"b": 2, "a": 1})


def test_stream_replays_recorded_events_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = {
        "placeholder": False,
        "recordedAt": "2026-10-11T00:00:00+00:00",
        "model": "claude-opus-5-5",
        "data": {"answer": "final"},
        "events": [{"at": 0, "event": {"step": 1}}, {"at": 5, "event": {"step": 2}}],
    }
    monkeypatch.setattr(demo, "find_fixture", lambda store, key: fixture)

    def live(*_: object) -> Live:
        raise AssertionError("the model must not be called in demo mode")

    stream_app = FastAPI()

    @stream_app.post("/stream")
    def stream() -> Response:
        return respond_stream("x", {"demoId": "p"}, None, live, replay_speed=100)

    res = TestClient(stream_app).post("/stream")
    assert res.headers["content-type"].startswith("text/event-stream")
    received = [json.loads(c.removeprefix("data: ")) for c in res.text.split("\n\n") if c]
    assert [f["type"] for f in received] == ["meta", "event", "event", "done"]
    assert received[1]["event"] == {"step": 1}
    assert received[3]["data"] == {"answer": "final"}


def test_live_stream_tells_the_work_to_stop_when_the_visitor_disconnects() -> None:
    class Visitor:
        connected = True

        async def is_disconnected(self) -> bool:
            return not self.connected

    visitor = Visitor()
    emitted: list[bool] = []
    stream_closed = threading.Event()
    work_finished = threading.Event()

    def live(_: object, emit: Any) -> Live:
        emitted.append(emit({"step": 1}))
        stream_closed.wait(5)  # the work is quiet (a slow model call) while the visitor leaves
        emitted.append(emit({"step": 2}))
        work_finished.set()
        return Live(data={"never": "sent"})

    async def read() -> list[dict[str, Any]]:
        response = respond_stream("x", {"q": 1}, object(), live, request=visitor)  # type: ignore[arg-type]
        received = []
        async for chunk in response.body_iterator:  # type: ignore[union-attr]
            received.append(json.loads(str(chunk).removeprefix("data: ")))
            if len(received) == 2:
                visitor.connected = False  # gone after the meta frame and the first event
        return received

    received = asyncio.run(read())
    stream_closed.set()
    assert work_finished.wait(5)
    assert [f["type"] for f in received] == ["meta", "event"]  # the stream ended on its own
    assert emitted == [True, False]  # ...and the work was told nobody is listening
