"""The shape of an analyst session: what the API streams and what the fixtures store.

One definition for the live path, the export script, and the tests, so a fixture that
validates here is something the real pipeline could have produced.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolCallRecord(Strict):
    id: str
    name: Literal["get_metric", "run_stress_test", "rebalance_to_target", "monte_carlo"]
    input: dict[str, Any]
    output: Any
    isError: bool
    round: int


class NumberCheck(Strict):
    text: str
    value: float
    unit: Literal["percent", "bps", "plain"]
    status: Literal["matched", "question", "unmatched"]
    callId: str | None
    tool: str | None
    path: str | None
    sourceValue: float | None
    approximate: bool
    alternatives: int


class Segment(Strict):
    text: str
    number: int | None = None


class Ignored(Strict):
    text: str
    reason: Literal["date", "year", "name", "identifier", "ordinal", "list marker"]


class Provenance(Strict):
    segments: list[Segment]
    numbers: list[NumberCheck]
    matched: int
    fromQuestion: int
    unmatched: int
    ignored: list[Ignored]


class SelfTest(Strict):
    answer: str
    provenance: Provenance
    original: str
    altered: str


class Session(Strict):
    question: str
    answer: str
    calls: list[ToolCallRecord]
    rounds: int
    usedTools: bool
    provenance: Provenance
    selfTest: SelfTest | None


class RoundEvent(Strict):
    type: Literal["round"]
    round: int


class NoteEvent(Strict):
    type: Literal["note"]
    text: str


class ToolEvent(Strict):
    type: Literal["tool"]
    call: ToolCallRecord


class RetryEvent(Strict):
    type: Literal["retry"]
    reason: Literal["no_tools"]


Event = Annotated[RoundEvent | NoteEvent | ToolEvent | RetryEvent, Field(discriminator="type")]


class EventEnvelope(Strict):
    event: Event
