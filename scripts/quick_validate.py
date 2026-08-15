#!/usr/bin/env python3
"""Skill-protocol gate. Run after any SKILL.md / validator change."""

from __future__ import annotations

import hashlib
import json
import re
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
    "yce-receipt",
    "yce:eof",
    "result_file",
    "--expect-sha256",
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


def run_validator(path: Path, extra: list[str] | None = None) -> tuple[int, dict]:
    proc = subprocess.run(
        ["node", str(VALIDATOR), str(path), *(extra or [])],
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
    # name, exit code, complete, ok, expected integrity ("" = don't care)
    cases = [
        ("search-present.xml", 0, True, True, "unverified"),
        ("success-without-result.xml", 3, True, False, ""),
        ("auto-enhance-fail-then-search.xml", 0, True, True, ""),
        ("parse-fail.xml", 2, False, False, ""),
        ("truncated.xml", 2, False, False, ""),
        ("search-with-errors.xml", 0, True, True, ""),
        ("task-context-new.xml", 0, True, True, ""),
        ("task-context-existing.xml", 0, True, True, ""),
        ("sentinel-verified.xml", 0, True, True, "verified"),
        ("sentinel-mismatch.xml", 2, False, False, "mismatch"),
        # 首尾都在、无任何截断字样：只能靠标签配对抓出来
        ("middle-elided.xml", 2, False, False, "unverified"),
        # 正文合法地引用了哨兵：降级为 unverified，但不得判文件损坏
        ("sentinel-quoted.xml", 0, True, True, "unverified"),
    ]
    for name, expected_code, complete, ok, integrity in cases:
        path = FIXTURES / name
        if not path.is_file():
            fail(f"missing fixture: {path}")
        code, payload = run_validator(path)
        if code != expected_code:
            fail(f"{name}: exit {code}, expected {expected_code}; summary={payload}")
        if payload.get("complete") is not complete or payload.get("ok") is not ok:
            fail(f"{name}: complete/ok mismatch: {payload}")
        if integrity and payload.get("integrity") != integrity:
            fail(f"{name}: integrity {payload.get('integrity')!r}, expected {integrity!r}")
        print(f"OK fixture {name} exit={code}")


def check_receipt_truth() -> None:
    """The receipt's digest must outrank the file's own sentinel."""
    path = FIXTURES / "sentinel-verified.xml"
    raw = path.read_text(encoding="utf-8")
    matches = list(re.finditer(r"<!--\s*yce:eof[^>]*-->", raw))
    if not matches:
        fail(f"{path.name} lost its sentinel")
    body = raw[: matches[-1].start()]
    body = body[:-2] if body.endswith("\r\n") else body.removesuffix("\n")
    real_sha = hashlib.sha256(body.encode("utf-8")).hexdigest()

    code, payload = run_validator(path, ["--expect-sha256", real_sha])
    if code != 0 or payload.get("integrity") != "verified":
        fail(f"matching receipt digest was rejected: exit {code}, {payload}")

    code, payload = run_validator(path, ["--expect-sha256", "c" * 64])
    if code != 2 or payload.get("integrity") != "mismatch":
        fail(f"wrong receipt digest was accepted: exit {code}, {payload}")

    # Usage errors go to stderr with no JSON, so bypass the JSON-expecting helper.
    proc = subprocess.run(
        ["node", str(VALIDATOR), str(path), "--expect-sha256", "not-a-digest"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 1:
        fail(f"malformed --expect-sha256 should be a usage error, got exit {proc.returncode}")
    if proc.stdout.strip():
        fail("usage error must not print a summary that could be mistaken for a pass")
    print("OK receipt digest outranks the in-file sentinel")


def check_adversarial_suite() -> None:
    suite = ROOT / "test" / "result-receipt.adversarial.test.cjs"
    if not suite.is_file():
        fail(f"missing adversarial suite: {suite}")
    print("OK adversarial suite present")


def check_gate_shared() -> None:
    """CLI receipt and the validator must never disagree: one implementation."""
    shared = ROOT / "scripts" / "lib" / "resultGate.js"
    if not shared.is_file():
        fail(f"missing shared gate module: {shared}")
    validator_text = VALIDATOR.read_text(encoding="utf-8")
    if "resultGate" not in validator_text:
        fail("validate-yce-result.mjs no longer reuses scripts/lib/resultGate.js")
    cli_text = (ROOT / "scripts" / "yce.js").read_text(encoding="utf-8")
    for needle in ("resultGate", "resultSink", "buildReceipt"):
        if needle not in cli_text:
            fail(f"scripts/yce.js no longer wires {needle}")
    print("OK CLI and validator share one gate implementation")


def main() -> None:
    if not VALIDATOR.is_file():
        fail(f"missing validator: {VALIDATOR}")
    check_skill()
    check_gate_shared()
    check_adversarial_suite()
    check_fixtures()
    check_receipt_truth()
    print("quick_validate: all checks passed")


if __name__ == "__main__":
    main()
