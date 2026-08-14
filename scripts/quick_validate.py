#!/usr/bin/env python3
"""Skill-protocol gate. Run after any SKILL.md / validator change."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "SKILL.md"
VALIDATOR = ROOT / "scripts" / "validate-yce-result.mjs"
FIXTURES = ROOT / "test" / "fixtures" / "yce-results"
REFERENCES = [
    "modes.md",
    "xml-contract.md",
    "task-anchors.md",
    "network-search.md",
    "windows-execution.md",
    "troubleshooting.md",
    "examples.md",
]

MAX_SKILL_LINES = 250
FORBIDDEN_IN_SKILL = ("最后记住", "YCE_TIMEOUT_PLAN_MS", "YCE_ENGINE_BOOTSTRAP_ENABLED")
REQUIRED_IN_SKILL = (
    "不可违反的主流程",
    "validate-yce-result.mjs",
    "result-present",
    "truncated",
    "token limit",
    "敏感信息",
)


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def skill_body_lines(text: str) -> list[str]:
    parts = text.split("---", 2)
    if len(parts) < 3:
        fail("SKILL.md is missing YAML frontmatter")
    return parts[2].splitlines()


def check_skill() -> None:
    text = SKILL.read_text(encoding="utf-8")
    body = skill_body_lines(text)
    nonempty = [line for line in body if line.strip()]
    if len(body) > MAX_SKILL_LINES:
        fail(f"SKILL.md body has {len(body)} lines; limit is {MAX_SKILL_LINES}")
    print(f"OK skill body lines={len(body)} nonempty={len(nonempty)}")
    for needle in REQUIRED_IN_SKILL:
        if needle not in text:
            fail(f"SKILL.md missing required phrase: {needle}")
    for needle in FORBIDDEN_IN_SKILL:
        if needle in text:
            fail(f"SKILL.md still contains moved/duplicate content: {needle}")
    for name in REFERENCES:
        path = ROOT / "references" / name
        if not path.is_file():
            fail(f"missing reference: {path}")
        if f"references/{name}" not in text and f"]({name})" not in text:
            # SKILL.md uses references/<file>
            if f"references/{name}" not in text and name not in text:
                fail(f"SKILL.md does not link to {name}")
    print("OK references present and linked")


def run_validator(path: Path) -> tuple[int, dict]:
    proc = subprocess.run(
        ["node", str(VALIDATOR), str(path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        fail(f"{path.name}: validator stdout is not JSON ({error}): {proc.stdout[:400]}")
    return proc.returncode, payload


def check_fixtures() -> None:
    cases = [
        ("search-present.xml", 0, True, True),
        ("success-without-result.xml", 3, True, False),
        ("auto-enhance-fail-then-search.xml", 0, True, True),
        ("parse-fail.xml", 2, False, False),
        ("truncated.xml", 2, False, False),
        ("search-with-errors.xml", 0, True, True),
        ("task-context-new.xml", 0, True, True),
        ("task-context-existing.xml", 0, True, True),
    ]
    for name, expected_code, complete, ok in cases:
        path = FIXTURES / name
        if not path.is_file():
            fail(f"missing fixture: {path}")
        code, payload = run_validator(path)
        if code != expected_code:
            fail(f"{name}: exit {code}, expected {expected_code}; summary={payload}")
        if payload.get("complete") is not complete or payload.get("ok") is not ok:
            fail(f"{name}: complete/ok mismatch: {payload}")
        print(f"OK fixture {name} exit={code}")


def main() -> None:
    if not VALIDATOR.is_file():
        fail(f"missing validator: {VALIDATOR}")
    check_skill()
    check_fixtures()
    print("quick_validate: all checks passed")


if __name__ == "__main__":
    main()
