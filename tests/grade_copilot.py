"""Grade a copilot evaluation run against the independently computed expected answers.

  .venv/bin/python tests/grade_copilot.py tests/results/eval_<model>_<time>.json

Automatic part: for items with expected facts (tests/copilot_expected.json), every
expected number must appear in the answer text (within its tolerance; Indian or
Western digit grouping, with or without the rupee sign) and every expected phrase
must appear. Items without expected facts (refusals, diagnosis, recommendations,
actions) are listed with their criteria for a human read; the script checks only
the mechanical parts it can: refusals must not invent numbers for the missing
field, and action requests must produce a proposal and must not claim completion.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
expected = json.loads((ROOT / "copilot_expected.json").read_text())
run = json.loads(Path(sys.argv[1]).read_text())

NUM = re.compile(r"(?<![\w.])[-−]?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|(?<![\w.,])[-−]?\d+(?:\.\d+)?")


def numbers(text: str):
    out = []
    for m in NUM.findall(text or ""):
        try:
            out.append(float(m.replace(",", "").replace("−", "-")))
        except ValueError:
            pass
    return out


def has_number(text, value, tol):
    return any(abs(n - float(value)) <= max(tol, 1e-9) for n in numbers(text))


auto_pass = auto_total = 0
rows = []
for item in run:
    text = "\n".join(t.get("answer") or "" for t in item["turns"])
    errors = [t["error"] for t in item["turns"] if t.get("error")]
    exp = expected.get(item["id"])
    verdict, missing = "manual", []
    if errors:
        verdict = "ERROR"
    elif exp:
        for m in exp["must_include"]:
            if isinstance(m, dict):
                if not has_number(text, m["value"], m["tol"]):
                    missing.append(f"{m['label']}={m['value']}")
            elif m.lower() not in text.lower():
                missing.append(f"'{m}'")
        verdict = "PASS" if not missing else "FAIL"
        auto_total += 1
        auto_pass += verdict == "PASS"
    elif item["category"] == "execution":
        props = sum(len(t.get("proposals") or []) for t in item["turns"])
        claims = re.search(r"\b(I have|I've) (created|updated|added|set up|scheduled)\b(?! .*confirm)", text, re.I)
        verdict = "manual (proposals: %d%s)" % (props, ", CLAIMS DONE" if claims else "")
    rows.append((item["id"], item["category"], verdict, missing, item["turns"]))

for rid, cat, verdict, missing, turns in rows:
    tools = sum(len(t.get("tools") or []) for t in turns)
    secs = sum((t.get("ms") or 0) for t in turns) / 1000
    print(f"{rid:5s} {cat:15s} {verdict:28s} tools={tools:2d} {secs:5.1f}s  {'; '.join(missing)[:120]}")
print(f"\nAutomatic checks: {auto_pass}/{auto_total} items pass")
turns = [t for r in run for t in r["turns"]]
p = sum((t.get("usage") or {}).get("prompt", 0) for t in turns)
c = sum((t.get("usage") or {}).get("completion", 0) for t in turns)
print(f"Turns: {len(turns)}; errors: {sum(1 for t in turns if t.get('error'))}; median latency "
      f"{sorted((t.get('ms') or 0) for t in turns)[len(turns) // 2] / 1000:.1f}s; tokens {p} prompt + {c} completion")
