#!/usr/bin/env python3
"""Summarise voice-worker turn telemetry (the `"evt":"turn"` log lines).

Usage:
  ssh prod-backend 'docker logs voice-agent 2>&1' | python3 scripts/turn-report.py
  ... | python3 scripts/turn-report.py --since 2026-11-17T13:00
"""
import json
import sys
from collections import Counter


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(round(p / 100 * (len(values) - 1))))]


def row(name, values):
    values = [v for v in values if isinstance(v, (int, float))]
    if not values:
        return f"{name:28} {'-':>5}"
    return f"{name:28} {len(values):>5} {pct(values, 50):>7} {pct(values, 75):>7} {pct(values, 90):>7} {max(values):>7}"


def main():
    since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else ""
    turns = []
    for line in sys.stdin:
        if '"evt":"turn"' not in line:
            continue
        try:
            t = json.loads(line[line.index("{"):])
        except ValueError:
            continue
        if t.get("heard") and "e2eMs" in t and t.get("ts", "") >= since:
            turns.append(t)

    if not turns:
        print("no instrumented user turns found")
        return

    print(f"user turns: {len(turns)}  sessions: {len({t['room'] for t in turns})}  "
          f"interrupted: {sum(1 for t in turns if t.get('interrupted'))}\n")
    print(f"{'metric (ms)':28} {'n':>5} {'p50':>7} {'p75':>7} {'p90':>7} {'max':>7}")
    print(row("e2e (stop -> agent audio)", [t.get("e2eMs") for t in turns]))
    print(row("filler (stop -> filler)", [t.get("fillerMs") for t in turns]))
    print(row("endpointing", [t.get("endpointingMs") for t in turns]))
    print(row("stt final lag", [t.get("sttLagMs") for t in turns]))
    print(row("llm ttft (1st call)", [t.get("llmTtftMs") for t in turns]))
    print(row("llm duration (all calls)", [sum(c.get("durationMs") or 0 for c in t.get("llm", [])) for t in turns]))
    print(row("tts ttfb", [t.get("ttsTtfbMs") for t in turns]))
    print(row("rpc context.get", [r["ms"] for t in turns for r in t.get("rpc", []) if r["method"] == "context.get"]))
    print(row("rpc tool.execute", [r["ms"] for t in turns for r in t.get("rpc", []) if r["method"] == "tool.execute"]))

    with_eot = [t for t in turns if t.get("eotProb") is not None]
    unlikely = [t for t in with_eot if t["eotProb"] < t["eotThreshold"]]
    print(f"\nend-of-turn model: {len(with_eot)}/{len(turns)} turns scored, "
          f"{len(unlikely)} rated 'unlikely finished' (-> max wait)")
    print("eot by heard language:", dict(Counter(t.get("heardLang") for t in with_eot)),
          "| unscored:", dict(Counter(t.get("heardLang") for t in turns if t.get("eotProb") is None)))

    calls = [c for t in turns for c in t.get("llm", [])]
    prompt = sum(c.get("promptTokens") or 0 for c in calls)
    cached = sum(c.get("cachedTokens") or 0 for c in calls)
    print(f"\nllm calls per turn: {dict(sorted(Counter(t.get('llmCalls') for t in turns).items()))}")
    print(f"prompt tokens p50: {pct([c.get('promptTokens') or 0 for c in calls], 50) if calls else '-'}  "
          f"cached share: {cached / prompt:.0%}" if prompt else "prompt tokens: -")

    print("\nby reply path (e2e p50 / p90):")
    by_path = {}
    for t in turns:
        by_path.setdefault(">".join(t.get("steps") or ["none"]), []).append(t.get("e2eMs"))
    for path, values in sorted(by_path.items(), key=lambda kv: -len(kv[1])):
        values = [v for v in values if isinstance(v, (int, float))]
        if values:
            print(f"  {path:32} n={len(values):<4} {pct(values, 50):>6} / {pct(values, 90):>6}")


if __name__ == "__main__":
    main()
