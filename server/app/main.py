"""Drawdown risk API.

    uv run uvicorn app.main:app --reload --port 8300

Two endpoints do the work:

- POST /api/portfolio  holdings CSV in, the full analysis out. Deterministic, needs no key.
- POST /api/analyst    a question in, a streamed analyst session out. Needs the visitor's
                       key; without one it replays a preset session from fixtures.

The Next.js app bundles the sample portfolio's analysis, so it only calls this service
for uploaded holdings and live analyst runs.
"""

from __future__ import annotations

from typing import Any

import anthropic
from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .analyst import MAX_QUESTION_CHARS, run_analyst
from .config import Usage
from .frontier import simulate_frontier
from .http import Live, RateLimiter, create_app, get_client, respond_stream
from .portfolio import (
    MAX_CSV_BYTES,
    MAX_HOLDINGS,
    SAMPLE_TOTAL_VALUE,
    HoldingsError,
    Portfolio,
    analyze,
    normalize,
    parse_holdings_csv,
    sample_holdings,
)
from .prices import load_prices

app = create_app(
    "Drawdown risk API",
    default_origins=("http://localhost:3300", "http://localhost:3310"),
)
portfolio_limit = RateLimiter(limit=30, window_seconds=60)
analyst_limit = RateLimiter(limit=10, window_seconds=60)

# Same envelope as a Claude-backed route, for a response that made no model call.
NO_CALL_META = {
    "mode": "live",
    "placeholder": False,
    "recordedAt": None,
    "model": "none",
    "usage": Usage().as_dict(),
    "costUsd": 0,
}


class PortfolioBody(BaseModel):
    csv: str = Field(min_length=1, max_length=MAX_CSV_BYTES)


class HoldingIn(BaseModel):
    ticker: str = Field(min_length=1, max_length=8)
    weight: float = Field(gt=0)


class AnalystBody(BaseModel):
    demoId: str | None = Field(default=None, max_length=64)
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    holdings: list[HoldingIn] | None = Field(default=None, min_length=1, max_length=MAX_HOLDINGS)
    totalValue: float | None = Field(default=None, gt=0, le=1e12)


def _bad_request(error: HoldingsError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@app.post("/api/portfolio", dependencies=[Depends(portfolio_limit)])
def portfolio(body: PortfolioBody) -> JSONResponse:
    """Analyse uploaded holdings. They are held in memory for this request and never stored."""
    try:
        holdings, total_value, assumed = parse_holdings_csv(body.csv)
        book = Portfolio(load_prices(), holdings, total_value)
    except HoldingsError as error:
        raise _bad_request(error) from error
    data = {
        "analysis": analyze(book, value_assumed=assumed),
        "frontier": simulate_frontier(book),
    }
    return JSONResponse({"ok": True, "data": data, "meta": NO_CALL_META})


@app.post("/api/analyst", dependencies=[Depends(analyst_limit)], response_model=None)
def analyst(
    request: Request,
    body: AnalystBody,
    client: anthropic.Anthropic | None = Depends(get_client),
) -> Response:
    """Stream an analyst session over the sample portfolio, or over the holdings supplied."""
    payload: dict[str, Any] = body.model_dump(exclude_none=True)
    try:
        if body.holdings is None:
            book = Portfolio(load_prices(), sample_holdings(), SAMPLE_TOTAL_VALUE)
        else:
            amounts: dict[str, float] = {}
            for holding in body.holdings:
                ticker = holding.ticker.strip().upper()
                amounts[ticker] = amounts.get(ticker, 0.0) + holding.weight
            book = Portfolio(load_prices(), normalize(amounts), body.totalValue or 100_000.0)
            # A preset recording describes the sample portfolio, never someone's own holdings.
            payload.pop("demoId", None)
    except HoldingsError as error:
        raise _bad_request(error) from error

    def live(client: anthropic.Anthropic, emit: Any) -> Live:
        return run_analyst(client, book, body.question.strip(), emit)

    # Passing the request lets the stream notice a visitor who leaves, so the loop stops
    # before its next model call instead of running on their key to the end.
    return respond_stream("analyst", payload, client, live, request=request)
