#!/usr/bin/env python3
"""
Quality gate per il vault "Nutrie Brain".

Passa al setaccio ogni nota .md nelle cartelle di contenuto (tutte tranne
sources/ e workspace/, che sono materiale grezzo e scratch) e la controlla
contro 6 regole:

  1. Frontmatter completo: title, summary, tags, status, created, updated.
  2. Corpo della nota <= 300 righe.
  3. Almeno 3 wikilink [[...]] in uscita verso note reali (target unici,
     esclusi self-link e link verso note _index).
  4. Zero link rotti: ogni [[bersaglio]] deve corrispondere a una nota esistente.
  5. Zero orfani: ogni nota ha almeno 1 link in entrata (le note _index sono esenti).
  6. Una sola componente connessa nel grafo dei wikilink.

Ogni cartella puo' avere il proprio "_index.md": sono file omonimi tra loro
(stesso nome in cartelle diverse), quindi sono tenuti in memoria con un id
qualificato "cartella/_index" e non con il solo nome file, altrimenti si
sovrascriverebbero a vicenda nella tabella interna.

Uso:
    python quality_gate.py [percorso_vault]
    python quality_gate.py [percorso_vault] --workspace

Senza flag: controlla le 9 cartelle di contenuto con le 6 regole qui sopra.
Con --workspace: controlla le note .md di workspace/ (journal, bacheca, sentinella)
con un set ridotto -- link rotti, frontmatter, e una spazzata di crosta
(file .bak, DRAFT vecchi, note vuote). Vedi run_workspace_gate().

Se percorso_vault non e' indicato, usa la cartella corrente.
Non modifica nessun file: produce solo un referto testuale.
"""

import re
import sys
import time
from pathlib import Path
from collections import defaultdict, deque

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
    """Id univoco per una nota: 'cartella/nome' se e' un _index (nome duplicabile
    tra cartelle), altrimenti solo il nome (i nomi normali sono unici nel vault)."""
    return f"{folder_name}/{stem}" if is_index(stem) else stem


def parse_frontmatter(text: str):
    """Ritorna (dict_campi_frontmatter, corpo, ok_parsing)."""
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
    """Ritorna (notes, stem_to_ids).

    notes: id_univoco -> {path, stem, folder, frontmatter, body, links_out, raw_links}
    stem_to_ids: nome_file_senza_estensione -> lista di id (di solito 1 elemento;
                 piu' di uno solo per "_index", presente in piu' cartelle).
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
            "links_out": links_out,  # unici, esclusi self-link e target _index
            "raw_links": raw_links,  # tutti i link trovati, per il check "link rotti"
        }
    return notes, stem_to_ids


def check_frontmatter(notes, errors):
    for nid, n in sorted(notes.items()):
        if not n["frontmatter_parsed_ok"]:
            errors["1. Frontmatter incompleto"].append(
                f"{nid}: nessun blocco frontmatter YAML valido (--- ... ---) trovato"
            )
            continue
        missing = [f for f in REQUIRED_FIELDS if f not in n["frontmatter"] or not n["frontmatter"][f]]
        if missing:
            errors["1. Frontmatter incompleto"].append(
                f"{nid}: campi mancanti o vuoti -> {', '.join(missing)}"
            )


def check_body_length(notes, errors):
    for nid, n in sorted(notes.items()):
        n_lines = len(n["body"].splitlines())
        if n_lines > 300:
            errors["2. Corpo oltre 300 righe"].append(f"{nid}: {n_lines} righe")


def check_min_wikilinks(notes, errors, stem_to_ids):
    for nid, n in sorted(notes.items()):
        real_targets = {t for t in n["links_out"] if t in stem_to_ids}
        if len(real_targets) < 3:
            errors["3. Meno di 3 wikilink reali in uscita"].append(
                f"{nid}: {len(real_targets)} trovati ({', '.join(sorted(real_targets)) or 'nessuno'})"
            )


def check_broken_links(notes, stem_to_ids, errors):
    for nid, n in sorted(notes.items()):
        for raw_target in n["raw_links"]:
            target = raw_target.strip()
            if target == n["stem"]:
                continue
            if target not in stem_to_ids:
                errors["4. Link rotti"].append(f"{nid}: [[{target}]] non esiste")


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
            errors["5. Note orfane (0 link in entrata)"].append(nid)


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
            errors["6. Piu' di una componente connessa"].append(
                f"Isola {i} ({len(comp)} note): {', '.join(sorted(comp))}"
            )


# ==========================================================================
# Modalita' --workspace: set ridotto sulle note di workspace/
# ==========================================================================

WS_FRONTMATTER_DIRS = ("journal/sessions", "journal/daily", "sentinella")
WS_FRONTMATTER_FILES = ("bacheca.md", "bacheca-archivio.md")
WS_STALE_DAYS = 14

CODE_SPAN_RE = re.compile(r"```.*?```|`[^`]*`", re.DOTALL)


def strip_code(text: str) -> str:
    """Toglie blocchi e span di codice, cosi' un [[...]] citato tra backtick
    (tipico nelle note di diario che spiegano la sintassi) non conta come link."""
    return CODE_SPAN_RE.sub(" ", text)


def all_real_stems(vault_root: Path) -> set:
    """Universo dei bersagli validi per un [[wikilink]]: ogni nota .md del vault
    tranne quelle sotto sources/ e i template. Include contenuto + workspace,
    cosi' [[bacheca]] o [[sessione-2026-08-31]] risolvono."""
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
        print(f"Nessuna cartella workspace/ sotto {vault_root}")
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
                errors["1. Link rotti"].append(f"{nid}: [[{target}]] non esiste")

        if ws_needs_frontmatter(f, ws_root):
            fields, _body, parsed_ok = parse_frontmatter(text)
            if not parsed_ok:
                errors["2. Frontmatter mancante"].append(f"{nid}: nessun blocco --- ... ---")
            else:
                missing = [x for x in REQUIRED_FIELDS if x not in fields or not fields[x]]
                if missing:
                    errors["2. Frontmatter incompleto"].append(
                        f"{nid}: campi mancanti o vuoti -> {', '.join(missing)}"
                    )

        if not text.strip():
            errors["3. Nota vuota"].append(nid)

    # Spazzata di crosta su tutto Nutrie Brain/ (workspace + contenuto)
    now = time.time()
    for f in sorted(vault_root.rglob("*")):
        if not f.is_file() or any(p.startswith(".") for p in f.parts):
            continue
        rel = f.relative_to(vault_root).as_posix()
        if ".bak" in f.name:
            errors["4. Crosta: file di backup"].append(rel)
        elif "DRAFT" in f.name and f.suffix == ".md":
            age_days = (now - f.stat().st_mtime) / 86400
            if age_days > WS_STALE_DAYS:
                errors["4. Crosta: DRAFT fermo"].append(f"{rel} ({int(age_days)} giorni)")
        elif f.suffix == ".md" and not f.read_text(encoding="utf-8").strip():
            if rel not in errors["3. Nota vuota"]:
                errors["4. Crosta: .md vuoto"].append(rel)

    total = sum(len(v) for v in errors.values())
    print(f"Note workspace controllate: {len(md_files)}")
    print()
    if total == 0:
        print("OK, 0 problemi")
        return 0

    for rule in sorted(errors):
        print(f"### {rule} ({len(errors[rule])})")
        for msg in errors[rule]:
            print(f"  - {msg}")
        print()
    print(f"TOTALE: {total}")
    return 0


def main():
    args = [a for a in sys.argv[1:] if a != "--workspace"]
    workspace_mode = "--workspace" in sys.argv[1:]
    vault_root = Path(args[0]) if args else Path(".")
    vault_root = vault_root.resolve()

    if not vault_root.exists():
        print(f"Percorso non trovato: {vault_root}")
        sys.exit(1)

    if workspace_mode:
        sys.exit(run_workspace_gate(vault_root))

    notes, stem_to_ids = load_notes(vault_root)
    if not notes:
        print(f"Nessuna nota .md trovata sotto {vault_root} (escluse {', '.join(SKIP_DIRS)}).")
        sys.exit(1)

    errors = defaultdict(list)
    check_frontmatter(notes, errors)
    check_body_length(notes, errors)
    check_min_wikilinks(notes, errors, stem_to_ids)
    check_broken_links(notes, stem_to_ids, errors)
    check_orphans(notes, stem_to_ids, errors)
    check_single_component(notes, stem_to_ids, errors)

    total = sum(len(v) for v in errors.values())

    print(f"Note controllate: {len(notes)}")
    print()

    if total == 0:
        print("OK, 0 errori")
        return

    rule_order = [
        "1. Frontmatter incompleto",
        "2. Corpo oltre 300 righe",
        "3. Meno di 3 wikilink reali in uscita",
        "4. Link rotti",
        "5. Note orfane (0 link in entrata)",
        "6. Piu' di una componente connessa",
    ]
    for rule in rule_order:
        if rule in errors:
            print(f"### {rule} ({len(errors[rule])})")
            for msg in errors[rule]:
                print(f"  - {msg}")
            print()

    print(f"TOTALE ERRORI: {total}")


if __name__ == "__main__":
    main()
