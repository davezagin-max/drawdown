"""Number provenance: tie every figure in the analyst's answer to a tool output.

The model is told to take every number from a tool result. This module does not take
its word for it. It finds each number in the answer, and looks for a tool output from
the same session that the number is a faithful rounding of.

What counts as a match
- A number written with d decimals matches a source value v when |v| rounds to it at
  d decimals: "18.7%" matches 0.186872 (as a percentage) and "1.08" matches 1.076261.
- Units follow the tool outputs' naming rule. A percentage is a fraction times 100
  ("18.7%" for 0.186872), unless the field name ends in `_pct`, which is already in
  percent ("20%" for a `market_shock_pct` of -20). A dollar amount must come from a
  field whose name ends in `_usd`.
- Magnitudes are compared, not signs, because prose carries direction in words
  ("fell 30.0%" for a drawdown of -0.2997).
- "$63k" and "$1.2 million" are scaled before comparing. A round figure with at least
  two significant digits ("$63,000") may also match a value it is a coarser rounding of
  (63,313.05); such a match is marked approximate.
- Zero only matches an exact zero.

What is not treated as a figure
- Dates and years ("2022-08-04", "March 30", "in 2022"), ordinals ("2nd"), list
  markers ("1."), index names ("S&P 500"), and numbers inside identifiers ("Q3", "p95").

A number with no tool source is checked against the visitor's own question (restating
"20%" from the question is not an invention). Anything left is `unmatched`, and the UI
flags it as "not from a tool".

Limits, stated plainly: this proves a figure exists in the tool outputs at the precision
quoted. It does not prove the sentence around it is true, and a vague figure such as
"1" is weak evidence because many values round to it.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

_MONTH = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|"
    r"Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?"
)
_NOT_A_FIGURE = r"(?!\s?%|\.\d|,\d{3})"
# Spans that contain digits but are not figures. Checked in order; first hit wins.
_PROTECTED: list[tuple[str, re.Pattern[str]]] = [
    ("date", re.compile(r"\b\d{4}-\d{2}-\d{2}\b")),
    ("date", re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b")),
    ("date", re.compile(r"\b(?:19|20)\d{2}\s?[-–]\s?(?:(?:19|20)\d{2}|\d{2})\b" + _NOT_A_FIGURE)),
    (
        "date",
        re.compile(
            rf"\b{_MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?\b{_NOT_A_FIGURE}(?:,?\s+(?:19|20)\d{{2}}\b)?"
        ),
    ),
    (
        "date",
        re.compile(
            rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?{_MONTH}(?:,?\s+(?:19|20)\d{{2}})?\b"
        ),
    ),
    ("date", re.compile(rf"\b{_MONTH},?\s+(?:19|20)\d{{2}}\b")),
    (
        "name",
        re.compile(r"S&P\s?\d+|Russell\s?\d+|Nasdaq[- ]?100|Fortune\s?\d+|401\(k\)", re.IGNORECASE),
    ),
]

_NUMBER = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<![\d.])\.\d+")
_SIGNS = "-−–"

# (pattern right after the digits, unit, multiplier). Order matters: longest first.
_SUFFIXES: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"\s?%"), "percent", 1.0),
    (re.compile(r"\s(?:percentage\s+points?|percent)\b"), "percent", 1.0),
    (re.compile(r"\s?pp\b"), "percent", 1.0),
    (re.compile(r"\s?(?:bps|bp|basis\s+points?)\b"), "bps", 1.0),
    (re.compile(r"\s?(?:billion|bn)\b|B\b"), "plain", 1e9),
    (re.compile(r"\s?(?:million|mm)\b|M\b"), "plain", 1e6),
    (re.compile(r"\s?thousand\b|[kK]\b"), "plain", 1e3),
    (re.compile(r"[xX]\b"), "plain", 1.0),
]
_ORDINAL = re.compile(r"(?:st|nd|rd|th)\b")

# A bare four-digit number is read as a year unless one of these follows it.
_COUNT_NOUN = re.compile(
    r"\s(?:simulations?|paths?|runs?|scenarios?|trials?|days?|shares?|dollars?|points?)\b"
)


def _scale(unit: str, field: str) -> float:
    """What to multiply a source value by to express it in the mention's unit."""
    already_percent = field.endswith("_pct")
    if unit == "percent":
        return 1.0 if already_percent else 100.0
    if unit == "bps":
        return 100.0 if already_percent else 10_000.0
    return 1.0


@dataclass(frozen=True)
class Source:
    """One number in one tool output."""

    call_id: str
    tool: str
    path: str  # where in the output, for example "after.volatility" or "positions[0].beta"
    value: float

    @property
    def field(self) -> str:
        """The name of the field the value sits in, without any list index."""
        return re.sub(r"\[\d+\]$", "", self.path.rsplit(".", 1)[-1])


@dataclass(frozen=True)
class Mention:
    """One figure found in the answer."""

    start: int
    end: int
    text: str
    value: float  # magnitude, after applying "k", "million", ...
    negative: bool
    currency: bool
    unit: str  # "percent", "bps", or "plain"
    tolerance: float  # half a unit of the last digit written
    loose_tolerance: float | None  # for round figures such as 63,000


def clean_answer(text: str) -> str:
    """Strip the few Markdown marks a model may add despite being asked for plain text."""
    text = re.sub(r"\*\*|__|`", "", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", text)
    text = re.sub(r"(?m)^(\s*)\*\s+", r"\1- ", text)
    return text.strip()


def collect_sources(calls: list[dict[str, Any]]) -> list[Source]:
    """Every finite number in the outputs of the calls that succeeded."""
    sources: list[Source] = []

    def walk(node: Any, path: str, call: dict[str, Any]) -> None:
        if isinstance(node, bool) or node is None:
            return
        if isinstance(node, int | float):
            if math.isfinite(node):
                sources.append(Source(call["id"], call["name"], path, float(node)))
        elif isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}" if path else str(key), call)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]", call)

    for call in calls:
        if not call.get("isError"):
            walk(call.get("output"), "", call)
    return sources


def _protected_spans(text: str) -> list[tuple[int, int, str]]:
    spans: list[tuple[int, int, str]] = []
    for reason, pattern in _PROTECTED:
        for match in pattern.finditer(text):
            if not any(s < match.end() and match.start() < e for s, e, _ in spans):
                spans.append((match.start(), match.end(), reason))
    return sorted(spans)


def extract(text: str) -> tuple[list[Mention], list[dict[str, str]]]:
    """Find the figures in `text`, and list what was deliberately skipped and why."""
    protected = _protected_spans(text)
    ignored = [{"text": text[s:e], "reason": reason} for s, e, reason in protected]
    mentions: list[Mention] = []

    for match in _NUMBER.finditer(text):
        start, end = match.span()
        if any(s <= start < e for s, e, _ in protected):
            continue
        digits = match.group()
        before = text[:start]
        after = text[end:]

        # Part of a word or identifier: "Q3", "p95", "var_95", "COVID-19".
        if re.search(r"[A-Za-z_]$", before) or re.search(r"[A-Za-z]-$", before):
            ignored.append({"text": digits, "reason": "identifier"})
            continue

        unit, multiplier, suffix_length = "plain", 1.0, 0
        for pattern, suffix_unit, suffix_multiplier in _SUFFIXES:
            suffix = pattern.match(after)
            if suffix:
                unit, multiplier, suffix_length = suffix_unit, suffix_multiplier, suffix.end()
                break
        if suffix_length == 0 and re.match(r"[A-Za-z]", after):
            reason = "ordinal" if _ORDINAL.match(after) else "identifier"
            ignored.append({"text": digits, "reason": reason})
            continue

        # Currency and sign may sit in front, in either order: "-$1,200" or "$-1,200".
        lead = start
        currency = False
        negative = False
        for _ in range(2):
            if lead > 0 and text[lead - 1] == "$" and not currency:
                currency, lead = True, lead - 1
            elif (
                lead > 0
                and text[lead - 1] in _SIGNS
                and not negative
                and (lead == 1 or text[lead - 2] in " \t\n($")
            ):
                negative, lead = True, lead - 1

        plain_integer = "." not in digits and "," not in digits
        if (
            plain_integer
            and len(digits) == 4
            and 1900 <= int(digits) <= 2100
            and not currency
            and suffix_length == 0
            and not _COUNT_NOUN.match(after)
        ):
            ignored.append({"text": digits, "reason": "year"})
            continue
        line_start = before.rsplit("\n", 1)[-1].strip() == ""
        if plain_integer and line_start and not currency and re.match(r"[.)]\s", after):
            ignored.append({"text": digits, "reason": "list marker"})
            continue

        bare = digits.replace(",", "")
        decimals = len(bare.split(".")[1]) if "." in bare else 0
        loose = None
        if decimals == 0 and multiplier == 1.0:
            significant = bare.rstrip("0")
            zeros = len(bare) - len(significant)
            if zeros and len(significant) >= 2:
                loose = 0.5 * 10**zeros
        mentions.append(
            Mention(
                start=lead,
                end=end + suffix_length,
                text=text[lead : end + suffix_length],
                value=float(bare) * multiplier,
                negative=negative,
                currency=currency,
                unit=unit,
                tolerance=0.5 * 10**-decimals * multiplier,
                loose_tolerance=loose,
            )
        )
    return mentions, ignored


def _best_source(mention: Mention, sources: list[Source]) -> tuple[Source, bool] | None:
    """The closest source the mention is a faithful rounding of, and whether it is approximate."""
    best: tuple[tuple[int, float, int], Source] | None = None
    slack = 1e-9 * max(1.0, mention.value)
    for order, source in enumerate(sources):
        field = source.field
        if mention.currency and not field.endswith("_usd"):
            continue
        candidate = abs(source.value) * _scale(mention.unit, field)
        error = abs(candidate - mention.value)
        if mention.value == 0:
            rank = 0 if candidate < 1e-12 else None
        elif error <= mention.tolerance + slack:
            rank = 0
        elif mention.loose_tolerance is not None and error <= mention.loose_tolerance:
            rank = 1
        else:
            rank = None
        if rank is None:
            continue
        # Exact roundings beat approximate ones, then the closest value, then the earliest call.
        key = (rank, round(error, 12), order)
        if best is None or key < best[0]:
            best = (key, source)
    if best is None:
        return None
    return best[1], best[0][0] == 1


def check_provenance(
    answer: str, calls: list[dict[str, Any]], question: str = ""
) -> dict[str, Any]:
    """Classify every figure in `answer` and split the text so the UI can mark each one.

    `calls` are the session's tool calls as dicts with `id`, `name`, `output`, `isError`.
    """
    sources = collect_sources(calls)
    asked = {(m.value, m.unit) for m in extract(question)[0]} if question else set()
    # A figure restated from the question is not an invention, but it is not evidence either.
    mentions, ignored = extract(answer)

    numbers: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []
    cursor = 0
    for mention in mentions:
        if mention.start > cursor:
            segments.append({"text": answer[cursor : mention.start]})
        found = _best_source(mention, sources)
        entry: dict[str, Any] = {
            "text": mention.text,
            "value": -mention.value if mention.negative else mention.value,
            "unit": mention.unit,
            "status": "unmatched",
            "callId": None,
            "tool": None,
            "path": None,
            "sourceValue": None,
            "approximate": False,
        }
        if found is not None:
            source, approximate = found
            entry.update(
                status="matched",
                callId=source.call_id,
                tool=source.tool,
                path=source.path,
                sourceValue=source.value,
                approximate=approximate,
            )
        elif (mention.value, mention.unit) in asked:
            entry["status"] = "question"
        segments.append({"text": mention.text, "number": len(numbers)})
        numbers.append(entry)
        cursor = mention.end
    if cursor < len(answer):
        segments.append({"text": answer[cursor:]})

    return {
        "segments": segments,
        "numbers": numbers,
        "matched": sum(1 for n in numbers if n["status"] == "matched"),
        "fromQuestion": sum(1 for n in numbers if n["status"] == "question"),
        "unmatched": sum(1 for n in numbers if n["status"] == "unmatched"),
        "ignored": ignored,
    }


def self_test(
    answer: str, calls: list[dict[str, Any]], question: str = ""
) -> dict[str, Any] | None:
    """Alter one traced figure and run the checker again.

    The altered copy should come back with that figure flagged. Shipping the result next
    to the real one lets a reader see the checker fail when it should, on this answer.
    Returns None when the answer has no figure that can be altered cleanly.
    """
    original = check_provenance(answer, calls, question)
    sources = collect_sources(calls)
    offset = 0
    for segment in original["segments"]:
        text = segment["text"]
        index = segment.get("number")
        start = offset
        offset += len(text)
        if index is None or original["numbers"][index]["status"] != "matched":
            continue
        digits = _NUMBER.search(text)
        if digits is None or "," in digits.group():
            continue
        shown = digits.group()
        decimals = len(shown.split(".")[1]) if "." in shown else 0
        # Try a few bumps; keep the first that no tool output could be rounded to.
        for bump in (1.37, 2.61, 3.83, 5.19):
            changed = f"{float(shown) * bump + 1:.{decimals}f}"
            replacement = text[: digits.start()] + changed + text[digits.end() :]
            altered = answer[:start] + replacement + answer[start + len(text) :]
            mention = next((m for m in extract(altered)[0] if m.start == start), None)
            if mention is None or _best_source(mention, sources) is not None:
                continue
            result = check_provenance(altered, calls, question)
            if result["unmatched"] == original["unmatched"] + 1:
                return {
                    "answer": altered,
                    "provenance": result,
                    "original": text,
                    "altered": replacement,
                }
    return None
