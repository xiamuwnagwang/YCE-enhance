#!/usr/bin/env python3
"""Opt-in live smoke against the public YCE relay.

Consumes search / enhance / network / Y-Plan quota.
Never prints tokens, cookies, or raw XML bodies.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-yce-result.mjs"
CLI = ROOT / "scripts" / "yce.js"
MCP_BIN = ROOT / "target" / "debug" / "yce-mcp"
TOKEN_FILES = [
    Path.home() / ".agents" / "skills" / "yce" / ".env",
    Path.home() / ".claude" / "skills" / "yce" / ".env",
    ROOT / ".env",
]


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_token() -> str:
    env_token = os.environ.get("YCE_RELAY_TOKEN", "").strip()
    if env_token:
        return env_token
    for path in TOKEN_FILES:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            if key.strip() != "YCE_RELAY_TOKEN":
                continue
            token = value.strip().strip('"').strip("'")
            if token:
                return token
    fail("missing YCE_RELAY_TOKEN (set env or install skill .env)")
    raise AssertionError("unreachable")


def child_env(token: str) -> dict[str, str]:
    env = os.environ.copy()
    env["YCE_RELAY_TOKEN"] = token
    env["YCE_DISABLE_UPDATE_CHECK"] = "1"
    env.pop("YCE_YOUWEN_TOKEN", None)
    return env


def run_validator(xml_path: Path) -> tuple[int, dict]:
    proc = subprocess.run(
        ["node", str(VALIDATOR), str(xml_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if not proc.stdout.strip():
        fail(f"validator produced no JSON for {xml_path.name}: {proc.stderr[-400:]}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        fail(f"validator stdout is not JSON ({error})")
    return proc.returncode, payload


def summarize(name: str, code: int, payload: dict) -> None:
    print(
        json.dumps(
            {
                "case": name,
                "exit": code,
                "ok": payload.get("ok"),
                "complete": payload.get("complete"),
                "integrity": payload.get("integrity"),
                "truncation_detected": payload.get("truncation_detected"),
                "success": payload.get("success"),
                "resolved_action": payload.get("resolved_action"),
                "search_present": (payload.get("search") or {}).get("result_present"),
                "network_present": (payload.get("network") or {}).get("result_present"),
                "plan_present": (payload.get("plan") or {}).get("result_present"),
                "gate": payload.get("gate"),
                "error_codes": [item.get("code") for item in payload.get("errors") or []],
                "reasons": payload.get("reasons") or [],
            },
            ensure_ascii=False,
        )
    )


def parse_receipt(stdout: str) -> dict:
    start = stdout.find("<yce-receipt>")
    end = stdout.find("</yce-receipt>")
    if start < 0 or end < 0:
        fail(f"cli stdout has no receipt: {stdout[:300]}")
    try:
        return json.loads(stdout[start + len("<yce-receipt>") : end].strip())
    except json.JSONDecodeError as error:
        fail(f"receipt is not JSON ({error})")


def run_cli(token: str, args: list[str], timeout: int) -> str:
    """Exercise the default path: results land in a file, stdout is a receipt."""
    with tempfile.TemporaryDirectory(prefix="yce-smoke-cli-") as staging:
        out_path = Path(staging) / "result.xml"
        proc = subprocess.run(
            ["node", str(CLI), *args, "--out", str(out_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=child_env(token),
            timeout=timeout,
        )
        if proc.returncode not in (0, 1, 2, 3):
            fail(f"cli crashed rc={proc.returncode} stderr={proc.stderr[-500:]}")
        receipt = parse_receipt(proc.stdout)
        if receipt.get("exit_code") != proc.returncode:
            fail(
                f"receipt exit_code={receipt.get('exit_code')} but process rc={proc.returncode}"
            )
        if receipt.get("result_file") != str(out_path):
            fail(f"receipt result_file={receipt.get('result_file')!r}, expected {out_path}")
        if not out_path.is_file():
            fail(f"cli did not write the result file: {out_path}")
        # Full text includes the yce:eof sentinel, so the caller re-validates it.
        return out_path.read_text(encoding="utf-8")


def expect(name: str, xml: str, out_dir: Path, allowed: set[int], require: dict) -> dict:
    path = out_dir / f"{name}.xml"
    path.write_text(xml, encoding="utf-8")
    code, payload = run_validator(path)
    summarize(name, code, payload)
    if code not in allowed:
        fail(f"{name}: validator exit {code}, allowed {sorted(allowed)}")
    for key, value in require.items():
        actual = payload
        for part in key.split("."):
            actual = (actual or {}).get(part) if isinstance(actual, dict) else None
        if actual is not value:
            fail(f"{name}: {key}={actual!r}, expected {value!r}")
    return payload


def run_mcp_search(token: str, out_dir: Path) -> None:
    if not MCP_BIN.is_file():
        fail(f"missing MCP binary: {MCP_BIN}")
    frames = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "yce-real-smoke", "version": "1"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "search_code",
                "arguments": {
                    "query": "Locate the YCE XML consumption validator script",
                    "cwd": str(ROOT),
                    "max_turns": 2,
                    "max_results": 6,
                },
            },
        },
    ]
    payload = "\n".join(json.dumps(frame, separators=(",", ":")) for frame in frames) + "\n"
    proc = subprocess.run(
        [str(MCP_BIN), "--runtime-root", str(ROOT)],
        input=payload,
        capture_output=True,
        text=True,
        env=child_env(token),
        timeout=240,
    )
    if proc.returncode != 0:
        fail(f"mcp crashed rc={proc.returncode} stderr={proc.stderr[-500:]}")
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    if len(lines) != 2:
        fail(f"mcp response count {len(lines)}, expected 2")
    text = (
        ((lines[1].get("result") or {}).get("content") or [{}])[0].get("text") or ""
    )
    if "<yce-consume>" not in text:
        fail("mcp search_code missing <yce-consume>")
    expect(
        "mcp-search",
        text,
        out_dir,
        {0},
        {
            "ok": True,
            "complete": True,
            "search.result_present": True,
            "gate.may_analyze_or_edit_code": True,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Opt-in live YCE smoke (consumes quota)")
    parser.add_argument(
        "--cases",
        default="help,search,search-empty,auto,network,plan,mcp-search",
    )
    args = parser.parse_args()
    selected = {item.strip() for item in args.cases.split(",") if item.strip()}
    token = load_token()
    print("opt-in live smoke: token loaded, bodies will not be printed")
    print("cases", ",".join(sorted(selected)))
    with tempfile.TemporaryDirectory(prefix="yce-real-smoke-") as tmp:
        out_dir = Path(tmp)

        if "help" in selected:
            help_xml = run_cli(token, ["--help"], 30)
            expect(
                "help",
                help_xml,
                out_dir,
                {3},
                {"ok": False, "gate.may_analyze_or_edit_code": False},
            )

        if "search" in selected:
            search_xml = run_cli(
                token,
                [
                    "Locate the validate-yce-result consumption gate and result-present checks",
                    "--mode",
                    "search",
                    "--cwd",
                    str(ROOT),
                    "--xml-pretty",
                    "--max-turns",
                    "2",
                    "--max-results",
                    "6",
                ],
                240,
            )
            expect(
                "search",
                search_xml,
                out_dir,
                {0},
                {
                    "ok": True,
                    "complete": True,
                    "search.result_present": True,
                    "gate.may_analyze_or_edit_code": True,
                },
            )

        if "search-empty" in selected:
            empty_dir = out_dir / "empty-project"
            empty_dir.mkdir()
            (empty_dir / "README.md").write_text("hello\n", encoding="utf-8")
            empty_xml = run_cli(
                token,
                [
                    "Locate the PostgreSQL WAL replication slot handler",
                    "--mode",
                    "search",
                    "--cwd",
                    str(empty_dir),
                    "--xml-pretty",
                    "--max-turns",
                    "1",
                    "--max-results",
                    "3",
                ],
                180,
            )
            empty_payload = expect("search-empty", empty_xml, out_dir, {0, 3}, {})
            if empty_payload.get("search", {}).get("result_present") is True:
                print("NOTE: search-empty still returned a result; live semantic search is not guaranteed empty")
            elif empty_payload.get("gate", {}).get("may_analyze_or_edit_code") is True:
                fail("search-empty has no result but still allows code edits")

        if "auto" in selected:
            auto_xml = run_cli(
                token,
                [
                    "Help me find where this validator decides a truncated YCE result is complete",
                    "--mode",
                    "auto",
                    "--cwd",
                    str(ROOT),
                    "--history",
                    "User: the skill was misreading truncated XML\nAI: the gate lives in validate-yce-result\nUser: Help me find where this validator decides a truncated YCE result is complete",
                    "--xml-pretty",
                    "--max-turns",
                    "2",
                    "--max-results",
                    "6",
                ],
                300,
            )
            expect(
                "auto",
                auto_xml,
                out_dir,
                {0},
                {
                    "ok": True,
                    "search.result_present": True,
                    "gate.may_analyze_or_edit_code": True,
                },
            )

        if "network" in selected:
            network_xml = run_cli(
                token,
                [
                    "What is the latest official Node.js 22 release line from nodejs.org",
                    "--mode",
                    "network",
                    "--network-profile",
                    "quick",
                    "--xml-pretty",
                ],
                180,
            )
            expect(
                "network",
                network_xml,
                out_dir,
                {0},
                {
                    "ok": True,
                    "network.result_present": True,
                    "gate.may_analyze_or_edit_code": False,
                    "gate.may_use_network_facts": True,
                },
            )

        if "plan" in selected:
            plan_xml = run_cli(
                token,
                [
                    "Add a dry-run flag to validate-yce-result without changing the XML contract",
                    "--mode",
                    "plan",
                    "--with-search",
                    "--cwd",
                    str(ROOT),
                    "--language",
                    "zh-CN",
                    "--xml-pretty",
                ],
                480,
            )
            expect(
                "plan",
                plan_xml,
                out_dir,
                {0},
                {
                    "ok": True,
                    "plan.result_present": True,
                    "gate.may_present_plan": True,
                },
            )

        if "mcp-search" in selected:
            run_mcp_search(token, out_dir)

    print("opt-in live smoke: selected cases passed")


if __name__ == "__main__":
    try:
        main()
    except subprocess.TimeoutExpired as error:
        fail(f"timed out: {error}")
