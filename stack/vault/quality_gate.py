#!/usr/bin/env python3
"""
Quality gate for the "company brain" Obsidian vault.

Sifts every .md note in the content folders (all of them except sources/ and
workspace/, which are raw material and scratch) and checks it against 6 rules:

  1. Complete frontmatter: title, summary, tags, status, created, updated.
  2. Note body <= 300 lines.
  3. At least 3 outgoing [[wikilinks]] to real notes (unique targets,
     excluding self links and links to _index notes).
  4. Zero broken links: every [[target]] must match a note that exists.
  5. Zero orphans: every note has at least 1 incoming link (_index notes are exempt).
  6. A single connected component in the wikilink graph.

Every folder can have its own "_index.md": those files share a name with each
other (same file name in different folders), so they are held in memory under a
qualified id "folder/_index" rather than under the file name alone, otherwise
they would overwrite each other in the internal table.

Usage:
    python quality_gate.py [vault_path]
    python quality_gate.py [vault_path] --workspace

Without the flag: checks the 9 content folders against the 6 rules above.
With --workspace: checks the .md notes under workspace/ (journal, task board,
weekly watch) against a reduced set -- broken links, frontmatter, and a sweep
for crust (.bak files, stale DRAFTs, empty notes). See run_workspace_gate().

If vault_path is not given, the current folder is used.
Modifies no file: it only produces a text report.
"""

import re
import sys
import time
from pathlib import Path
from collections import defaultdict, deque

# Folder names below are the real ones in the vault and are matched against
# paths, so they stay in Italian: "sentinella" is the weekly watch folder and
# "bacheca" is the task board.
SKIP_DIRS = {"sources", "workspace"}
REQUIRED_FIELDS = ["title", "summary", "tags", "status", "created", "updated"]
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)")
FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n(.*)$", re.DOTALL)


def is_index(name: str) -> bool:
    return name.lower().startswith("_index")


def find_content_dirs(vault_root: Path):
    return sorted(
        d for d in vault_root.iterdir()
        if d.is_dir() and d.name not in SKIP_DIRS
        and not d.name.startswith(".") and not d.name.startswith("_")
    )


def note_id(folder_name: str, stem: str) -> str:
    """Unique id for a note: 'folder/name' if it is an _index (a name that can
    repeat across folders), otherwise just the name (normal names are unique
    across the vault)."""
    return f"{folder_name}/{stem}" if is_index(stem) else stem


def parse_frontmatter(text: str):
    """Returns (frontmatter_fields_dict, body, parsing_ok)."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text, False

    fm_raw, body = m.group(1), m.group(2)
    fields = {}
    for line in fm_raw.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if key and key[0] not in " \t-":
            fields[key] = value
    return fields, body, True


def load_notes(vault_root: Path):
    """Returns (notes, stem_to_ids).

    notes: unique_id -> {path, stem, folder, frontmatter, body, links_out, raw_links}
    stem_to_ids: file_name_without_extension -> list of ids (usually 1 element;
                 more than one only for "_index", which appears in many folders).
    """
    raw = []  # (id, folder, stem, text)
    stem_to_ids = defaultdict(list)

    for d in find_content_dirs(vault_root):
        for f in sorted(d.glob("*.md")):
            stem = f.stem
            nid = note_id(d.name, stem)
            text = f.read_text(encoding="utf-8")
            raw.append((nid, d.name, stem, f, text))
            stem_to_ids[stem].append(nid)

    notes = {}
    for nid, folder, stem, f, text in raw:
        fields, body, parsed_ok = parse_frontmatter(text)
        raw_links = WIKILINK_RE.findall(text)
        links_out = []
        seen = set()
        for r in raw_links:
            target = r.strip()
            if target == stem or is_index(target):
                continue
            if target not in seen:
                seen.add(target)
                links_out.append(target)
        notes[nid] = {
            "path": f,
            "folder": folder,
            "stem": stem,
            "frontmatter": fields,
            "frontmatter_parsed_ok": parsed_ok,
            "body": body,
            "links_out": links_out,  # unique, excluding self links and _index targets
            "raw_links": raw_links,  # every link found, for the "broken links" check
        }
    return notes, stem_to_ids


def check_frontmatter(notes, errors):
    for nid, n in sorted(notes.items()):
        if not n["frontmatter_parsed_ok"]:
            errors["1. Incomplete frontmatter"].append(
                f"{nid}: no valid YAML frontmatter block (--- ... ---) found"
            )
            continue
        missing = [f for f in REQUIRED_FIELDS if f not in n["frontmatter"] or not n["frontmatter"][f]]
        if missing:
            errors["1. Incomplete frontmatter"].append(
                f"{nid}: missing or empty fields -> {', '.join(missing)}"
            )


def check_body_length(notes, errors):
    for nid, n in sorted(notes.items()):
        n_lines = len(n["body"].splitlines())
        if n_lines > 300:
            errors["2. Body over 300 lines"].append(f"{nid}: {n_lines} lines")


def check_min_wikilinks(notes, errors, stem_to_ids):
    for nid, n in sorted(notes.items()):
        real_targets = {t for t in n["links_out"] if t in stem_to_ids}
        if len(real_targets) < 3:
            errors["3. Fewer than 3 real outgoing wikilinks"].append(
                f"{nid}: {len(real_targets)} found ({', '.join(sorted(real_targets)) or 'none'})"
            )


def check_broken_links(notes, stem_to_ids, errors):
    for nid, n in sorted(notes.items()):
        for raw_target in n["raw_links"]:
            target = raw_target.strip()
            if target == n["stem"]:
                continue
            if target not in stem_to_ids:
                errors["4. Broken links"].append(f"{nid}: [[{target}]] does not exist")


def check_orphans(notes, stem_to_ids, errors):
    incoming = defaultdict(set)
    for nid, n in notes.items():
        for t in n["links_out"]:
            for target_id in stem_to_ids.get(t, []):
                if target_id != nid:
                    incoming[target_id].add(nid)

    for nid, n in sorted(notes.items()):
        if is_index(n["stem"]):
            continue
        if len(incoming[nid]) == 0:
            errors["5. Orphan notes (0 incoming links)"].append(nid)


def check_single_component(notes, stem_to_ids, errors):
    adj = defaultdict(set)
    for nid, n in notes.items():
        for t in n["links_out"]:
            for target_id in stem_to_ids.get(t, []):
                if target_id != nid:
                    adj[nid].add(target_id)
                    adj[target_id].add(nid)

    all_ids = set(notes.keys())
    if not all_ids:
        return

    visited = set()
    components = []
    for start in all_ids:
        if start in visited:
            continue
        comp = set()
        q = deque([start])
        visited.add(start)
        while q:
            cur = q.popleft()
            comp.add(cur)
            for nb in adj[cur]:
                if nb not in visited:
                    visited.add(nb)
                    q.append(nb)
        components.append(comp)

    if len(components) > 1:
        components.sort(key=len, reverse=True)
        for i, comp in enumerate(components, start=1):
            errors["6. More than one connected component"].append(
                f"Island {i} ({len(comp)} notes): {', '.join(sorted(comp))}"
            )


# ==========================================================================
# --workspace mode: reduced set over the notes in workspace/
# ==========================================================================

# Real folder and file names in the vault, kept as they are:
# "sentinella" is the weekly watch, "bacheca" is the task board.
WS_FRONTMATTER_DIRS = ("journal/sessions", "journal/daily", "sentinella")
WS_FRONTMATTER_FILES = ("bacheca.md", "bacheca-archivio.md")
WS_STALE_DAYS = 14

CODE_SPAN_RE = re.compile(r"```.*?```|`[^`]*`", re.DOTALL)


def strip_code(text: str) -> str:
    """Removes code blocks and code spans, so a [[...]] quoted between backticks
    (typical in journal notes explaining the syntax) does not count as a link."""
    return CODE_SPAN_RE.sub(" ", text)


def all_real_stems(vault_root: Path) -> set:
    """The universe of valid targets for a [[wikilink]]: every .md note in the
    vault except the ones under sources/ and the templates. Includes content and
    workspace, so [[bacheca]] or [[sessione-2026-08-31]] resolve."""
    stems = set()
    for f in vault_root.rglob("*.md"):
        parts = set(f.parts)
        if "sources" in parts or "_templates" in parts:
            continue
        if any(p.startswith(".") for p in f.parts):
            continue
        stems.add(f.stem)
    return stems


def ws_needs_frontmatter(f: Path, ws_root: Path) -> bool:
    rel = f.relative_to(ws_root).as_posix()
    if f.name in WS_FRONTMATTER_FILES:
        return True
    return any(rel.startswith(d + "/") for d in WS_FRONTMATTER_DIRS)


def run_workspace_gate(vault_root: Path) -> int:
    ws_root = vault_root / "workspace"
    if not ws_root.is_dir():
        print(f"No workspace/ folder under {vault_root}")
        return 1

    valid = all_real_stems(vault_root)
    errors = defaultdict(list)

    md_files = [
        f for f in sorted(ws_root.rglob("*.md"))
        if "_templates" not in f.parts and "DRAFT" not in f.name
    ]

    for f in md_files:
        nid = f.relative_to(ws_root).as_posix()
        text = f.read_text(encoding="utf-8")

        for raw_target in WIKILINK_RE.findall(strip_code(text)):
            target = raw_target.strip()
            if target == f.stem or is_index(target):
                continue
            if target not in valid:
                errors["1. Broken links"].append(f"{nid}: [[{target}]] does not exist")

        if ws_needs_frontmatter(f, ws_root):
            fields, _body, parsed_ok = parse_frontmatter(text)
            if not parsed_ok:
                errors["2. Missing frontmatter"].append(f"{nid}: no --- ... --- block")
            else:
                missing = [x for x in REQUIRED_FIELDS if x not in fields or not fields[x]]
                if missing:
                    errors["2. Incomplete frontmatter"].append(
                        f"{nid}: missing or empty fields -> {', '.join(missing)}"
                    )

        if not text.strip():
            errors["3. Empty note"].append(nid)

    # Crust sweep over the whole vault (workspace + content)
    now = time.time()
    for f in sorted(vault_root.rglob("*")):
        if not f.is_file() or any(p.startswith(".") for p in f.parts):
            continue
        rel = f.relative_to(vault_root).as_posix()
        if ".bak" in f.name:
            errors["4. Crust: backup file"].append(rel)
        elif "DRAFT" in f.name and f.suffix == ".md":
            age_days = (now - f.stat().st_mtime) / 86400
            if age_days > WS_STALE_DAYS:
                errors["4. Crust: stalled DRAFT"].append(f"{rel} ({int(age_days)} days)")
        elif f.suffix == ".md" and not f.read_text(encoding="utf-8").strip():
            if rel not in errors["3. Empty note"]:
                errors["4. Crust: empty .md"].append(rel)

    total = sum(len(v) for v in errors.values())
    print(f"Workspace notes checked: {len(md_files)}")
    print()
    if total == 0:
        # gate_hook.py matches this string to decide the run was clean.
        # Change it here and change it there in the same commit.
        print("OK, 0 problems")
        return 0

    for rule in sorted(errors):
        print(f"### {rule} ({len(errors[rule])})")
        for msg in errors[rule]:
            print(f"  - {msg}")
        print()
    print(f"TOTAL: {total}")
    return 0


def main():
    args = [a for a in sys.argv[1:] if a != "--workspace"]
    workspace_mode = "--workspace" in sys.argv[1:]
    vault_root = Path(args[0]) if args else Path(".")
    vault_root = vault_root.resolve()

    if not vault_root.exists():
        print(f"Path not found: {vault_root}")
        sys.exit(1)

    if workspace_mode:
        sys.exit(run_workspace_gate(vault_root))

    notes, stem_to_ids = load_notes(vault_root)
    if not notes:
        print(f"No .md note found under {vault_root} (excluding {', '.join(SKIP_DIRS)}).")
        sys.exit(1)

    errors = defaultdict(list)
    check_frontmatter(notes, errors)
    check_body_length(notes, errors)
    check_min_wikilinks(notes, errors, stem_to_ids)
    check_broken_links(notes, stem_to_ids, errors)
    check_orphans(notes, stem_to_ids, errors)
    check_single_component(notes, stem_to_ids, errors)

    total = sum(len(v) for v in errors.values())

    print(f"Notes checked: {len(notes)}")
    print()

    if total == 0:
        # gate_hook.py matches this string to decide the run was clean.
        # Change it here and change it there in the same commit.
        print("OK, 0 errors")
        return

    rule_order = [
        "1. Incomplete frontmatter",
        "2. Body over 300 lines",
        "3. Fewer than 3 real outgoing wikilinks",
        "4. Broken links",
        "5. Orphan notes (0 incoming links)",
        "6. More than one connected component",
    ]
    for rule in rule_order:
        if rule in errors:
            print(f"### {rule} ({len(errors[rule])})")
            for msg in errors[rule]:
                print(f"  - {msg}")
            print()

    print(f"TOTAL ERRORS: {total}")


if __name__ == "__main__":
    main()
