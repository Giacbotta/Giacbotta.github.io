#!/usr/bin/env python3
"""
PostToolUse hook for Claude Code: after every Write/Edit, if the file touched is
inside the vault, run the right quality gate and report back only if it finds
something.

- file under a content folder      -> quality_gate.py <vault>
- file under workspace/            -> quality_gate.py <vault> --workspace
- file under sources/ or outside   -> does nothing

The gate modifies nothing. If it is clean, this hook exits silently (exit 0).
If it finds errors it prints them on stderr and exits with code 2, so Claude
sees them and fixes them in the same turn.

Registered in .claude/settings.json as a PostToolUse hook with matcher "Write|Edit".
"""

import json
import subprocess
import sys
from pathlib import Path

# workspace/gate_hook.py -> parent.parent = the vault root
VAULT = Path(__file__).resolve().parent.parent
GATE = VAULT / "workspace" / "quality_gate.py"
SKIP_UNDER = {"sources"}


def read_event() -> dict:
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def edited_path(event: dict):
    ti = event.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("path")
    if not fp:
        return None
    try:
        return Path(fp).resolve()
    except Exception:
        return None


def classify(path: Path):
    """Returns 'content', 'workspace' or None (ignore)."""
    try:
        rel = path.relative_to(VAULT)
    except ValueError:
        return None
    parts = rel.parts
    if not parts or not path.name.endswith(".md"):
        return None
    top = parts[0]
    if top in SKIP_UNDER:
        return None
    if top == "workspace":
        return "workspace"
    return "content"


def main():
    if not GATE.exists():
        return 0
    event = read_event()
    path = edited_path(event)
    if path is None:
        return 0
    kind = classify(path)
    if kind is None:
        return 0

    cmd = [sys.executable, str(GATE), str(VAULT)]
    if kind == "workspace":
        cmd.append("--workspace")

    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        print(f"gate_hook: could not run the quality gate ({e})", file=sys.stderr)
        return 0

    report = (out.stdout or "") + (out.stderr or "")
    # These two strings are printed by quality_gate.py. They are the only signal
    # that the run was clean, so the two files have to be changed together.
    if "OK, 0 errors" in report or "OK, 0 problems" in report:
        return 0

    label = "workspace" if kind == "workspace" else "content"
    print(
        f"Quality gate ({label}) after editing {path.name}:\n\n{report.strip()}",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
