#!/usr/bin/env python3
"""Turn a Charles session export into scrubbed test fixtures.

The raw .chlsj captures contain live bearer tokens, a refresh token, the account
email, the owner's name, a building label, room names and real device
identifiers. None of that may reach the repository — and that includes this
file, so no real value is hardcoded anywhere below.

Scrubbing runs in two passes:

1. A structural walk of the known /context shape, which renames the identifying
   fields positionally (first unit becomes "Unit One", and so on). Walking the
   shape rather than matching key names is what keeps the settings array intact:
   its entries are also keyed {name, value}, and a blanket rename of "name"
   would rewrite RoomTemperature and friends.
2. A shape-based sweep over everything the walk did not reach — guest
   buildings, scenes, future fields — matching UUIDs, emails, adapter
   identifiers and JWTs by pattern. Anything unanticipated still cannot escape.

Replacements are memoised, so the same real value always yields the same fake
and fixtures stay diffable across regenerations.

    python3 scripts/build-fixtures.py '.idea/iPhone 03_08_2026 10_27.chlsj'
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parent.parent / "test" / "fixtures"

UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
ADAPTER_RE = re.compile(r"\bFE[0-9A-Fa-f]{32}\b")
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")

ORDINALS = (
    "One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve "
    "Thirteen Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen Twenty"
).split()

FAKE_EMAIL = "user@example.com"
FAKE_USER_ID = "00000000-0000-4000-8000-000000000000"


def _ordinal(index: int) -> str:
    """Positional word for a 0-based index, falling back to a bare number."""
    return ORDINALS[index] if index < len(ORDINALS) else str(index + 1)


class Anonymiser:
    """Assigns stable fake values, memoised by the real value they replace."""

    def __init__(self) -> None:
        self._uuids: dict[str, str] = {}
        self._adapters: dict[str, str] = {}
        self._counts: dict[str, int] = {}
        # Fakes already handed out. The structural walk runs before the sweep,
        # so without this the sweep would treat its predecessor's output as a
        # fresh real value and replace it a second time.
        self._issued: set[str] = set()

    def _next(self, kind: str) -> int:
        self._counts[kind] = self._counts.get(kind, 0) + 1
        return self._counts[kind]

    def uuid(self, real: str, kind: str = "other") -> str:
        """Map a UUID to a fake whose shape encodes what it identifies."""
        if real in self._issued:
            return real
        if real in self._uuids:
            return self._uuids[real]

        if kind == "user":
            fake = FAKE_USER_ID
        else:
            index = self._next(kind)
            if kind == "unit" and index <= 9:
                # Repeated-digit UUIDs make a failing test name its own unit.
                d = str(index)
                fake = f"{d * 8}-{d * 4}-4{d * 3}-8{d * 3}-{d * 12}"
            else:
                prefix = {"building": "bbbbbbbb", "system": "aaaaaaaa"}.get(kind, "cccccccc")
                fake = f"{prefix}-0000-4000-8000-{index:012d}"

        self._uuids[real] = fake
        self._issued.add(fake)
        return fake

    def adapter(self, real: str) -> str:
        """Map a wifi adapter identifier (FE + 32 hex) to a fake."""
        if real in self._issued:
            return real
        if real not in self._adapters:
            fake = f"FE{self._next('adapter'):032d}"
            self._adapters[real] = fake
            self._issued.add(fake)
        return self._adapters[real]

    def scrub_text(self, value: str) -> str:
        """Shape-based sweep for values the structural walk did not classify."""
        value = JWT_RE.sub("<redacted-jwt>", value)
        value = EMAIL_RE.sub(FAKE_EMAIL, value)
        value = ADAPTER_RE.sub(lambda m: self.adapter(m.group(0)), value)
        return UUID_RE.sub(lambda m: self.uuid(m.group(0)), value)

    def sweep(self, value: Any) -> Any:
        """Recursively apply the shape-based sweep."""
        if isinstance(value, dict):
            return {k: self.sweep(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.sweep(v) for v in value]
        if isinstance(value, str):
            return self.scrub_text(value)
        return value


def scrub_unit(unit: dict[str, Any], index: int, anon: Anonymiser) -> None:
    """Rename one air-to-air or air-to-water unit in place."""
    if isinstance(unit.get("id"), str):
        unit["id"] = anon.uuid(unit["id"], "unit")
    if isinstance(unit.get("systemId"), str):
        unit["systemId"] = anon.uuid(unit["systemId"], "system")
    if isinstance(unit.get("connectedInterfaceIdentifier"), str):
        unit["connectedInterfaceIdentifier"] = anon.adapter(unit["connectedInterfaceIdentifier"])
    # The room name is the most identifying field in the payload.
    unit["givenDisplayName"] = f"Unit {_ordinal(index)}"


def scrub_building(building: dict[str, Any], index: int, anon: Anonymiser) -> None:
    """Rename one building and every unit beneath it, in place."""
    if isinstance(building.get("id"), str):
        building["id"] = anon.uuid(building["id"], "building")
    building["name"] = "Test Building" if index == 0 else f"Test Building {index + 1}"

    unit_index = 0
    for key in ("airToAirUnits", "airToWaterUnits"):
        for unit in building.get(key) or []:
            if isinstance(unit, dict):
                scrub_unit(unit, unit_index, anon)
                unit_index += 1


def scrub_context(payload: dict[str, Any], anon: Anonymiser) -> dict[str, Any]:
    """Scrub a /context response: structural walk first, then the sweep."""
    if isinstance(payload.get("id"), str):
        payload["id"] = anon.uuid(payload["id"], "user")
    payload["firstname"] = "Test"
    payload["lastname"] = "User"
    payload["email"] = FAKE_EMAIL

    for key in ("buildings", "guestBuildings"):
        for index, building in enumerate(payload.get(key) or []):
            if isinstance(building, dict):
                scrub_building(building, index, anon)

    # Second pass catches scenes, guest metadata and any field added upstream.
    return anon.sweep(payload)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    entries = json.loads(Path(sys.argv[1]).read_text())
    FIXTURES.mkdir(parents=True, exist_ok=True)
    anon = Anonymiser()

    context = next(
        (e for e in entries if e["path"] == "/context" and e["response"].get("body")),
        None,
    )
    if context is None:
        print("No /context response in that capture.")
        return 1

    payload = scrub_context(json.loads(context["response"]["body"]["text"]), anon)
    (FIXTURES / "context.json").write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {FIXTURES / 'context.json'}")

    # Every distinct control payload the app produced, for round-trip tests.
    # Unit ids reuse the map built above, so commands line up with the context.
    commands = []
    seen = set()
    for entry in entries:
        if entry["method"] != "PUT" or "/monitor/ataunit/" not in entry["path"]:
            continue
        body = json.loads(entry["request"]["body"]["text"])
        key = json.dumps(body, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        unit = entry["path"].rsplit("/", 1)[-1]
        commands.append({"unitId": anon.uuid(unit, "unit"), "payload": anon.sweep(body)})

    if commands:
        (FIXTURES / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        print(f"wrote {FIXTURES / 'commands.json'} ({len(commands)} unique payloads)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
