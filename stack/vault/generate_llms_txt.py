#!/usr/bin/env python3
"""
Generates llms.txt at the root of the vault: the front-door index for AI.

llms.txt is a DERIVED file: this script always regenerates it from scratch out
of the notes' frontmatter. It is never edited by hand. If something is missing,
fix the source note and run the script again.

For every content folder (self, areas, projects, concepts, docs, entities,
data, code, outputs) it lists the notes in that folder in the format:

    - [[file-name]] -- summary

The summary comes ONLY from the "summary" field in each note's frontmatter:
no text is invented or summarised here. sources/ and workspace/ are excluded
because they hold raw material and scratch, not atomic notes.

Usage:
    python generate_llms_txt.py [vault_path]
"""

import re
import sys
from pathlib import Path

SKIP_DIRS = {"sources", "workspace"}
FOLDER_ORDER = [
    "self", "areas", "projects", "concepts", "docs",
    "entities", "data", "code", "outputs",
]
FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def parse_frontmatter(text: str):
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fields = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.strip().startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key[0] not in " \t-":
            fields[key] = value
    return fields


def find_content_dirs(vault_root: Path):
    present = [d.name for d in vault_root.iterdir() if d.is_dir()]
    ordered = [name for name in FOLDER_ORDER if name in present]
    extra = sorted(
        name for name in present
        if name not in FOLDER_ORDER and name not in SKIP_DIRS
        and not name.startswith(".") and not name.startswith("_")
    )
    return ordered + extra


def build_llms_txt(vault_root: Path) -> str:
    lines = ["# Vault index for AI", ""]

    for folder_name in find_content_dirs(vault_root):
        folder = vault_root / folder_name
        md_files = sorted(folder.glob("*.md"))

        lines.append(f"## {folder_name}")
        if not md_files:
            lines.append("(no notes)")
            lines.append("")
            continue

        for f in md_files:
            text = f.read_text(encoding="utf-8")
            fm = parse_frontmatter(text)
            summary = fm.get("summary", "")
            lines.append(f"- [[{f.stem}]] -- {summary}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main():
    vault_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    vault_root = vault_root.resolve()

    if not vault_root.exists():
        print(f"Path not found: {vault_root}")
        sys.exit(1)

    content = build_llms_txt(vault_root)
    out_path = vault_root / "llms.txt"
    out_path.write_text(content, encoding="utf-8")
    print(f"Written: {out_path}")


if __name__ == "__main__":
    main()
