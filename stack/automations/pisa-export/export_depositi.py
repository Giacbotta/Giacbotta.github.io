"""
Daily export of the Pisa site deposits to a Google Sheet.

Source: Onniversum management API (api.locker-vendor.example/api),
tenant Self Luggage Storage Pisa (HUB-001).

The sheet is rewritten in full on every run, so it is always a mirror of the
panel: if the machine is off for a day, the next run recovers the missing
days on its own. No state is kept locally.

Use:
    python export_depositi.py --schema     # prints the fields the API returns
    python export_depositi.py --dry-run    # downloads and summarizes, writes nothing
    python export_depositi.py --csv out.csv
    python export_depositi.py              # writes to the Google Sheet
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_URL = "https://api.locker-vendor.example/api"
PAGE_SIZE = 100  # cap set by the server: higher values get truncated
TIMEOUT = 30

# Fields that must NOT end up on the sheet. pickupCode is the code that opens
# the locker and apiKey is the kiosk's key: on a sheet that can be shared,
# they do not belong. The others are technical noise.
CAMPI_ESCLUSI = {
    "pickupCode",
    "apiKey",
    "sessionId",
    "payment.preAuthCode",
    "payment.preAuthPaymentId",
    "payment._id",
    "billing._id",
    "smartsale._id",
    "macAddress",
    "deliveryId",
    "__v",
    "_id",
}

# Known columns, in the order we want to read them. Fields the API returns
# that are not in this list get appended at the end, so if the vendor
# introduces new ones we do not lose them in silence.
COLONNE_PREFERITE = [
    "paccoId",
    "status",
    "createdAt",
    "depositStartAt",
    "depositConfirmedAt",
    "pickupStartedAt",
    "pickupCompletedAt",
    "lockerNumber",
    "dimensione",
    "locale",
    "emailMittente",
    "phoneMittente",
    "billing.durationLabel",
    "billing.durationMinutes",
    "billing.billingHours",
    "billing.rateLabel",
    "billing.totalNowEuro",
    "billing.alreadyPaidEuro",
    "billing.dueNowEuro",
    "billing.pickupSettled",
    "billing.billingNote",
    "payment.preAuthAmount",
    "payment.capturedAmount",
    "payment.totalCharged",
    "payment.totalAmount",
    "smartsale.status",
    "smartsale.progressivo",
    "smartsale.totale",
    "smartsale.emittedAt",
    "hubName",
]


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

def carica_env() -> dict[str, str]:
    """Reads the .env file next to the script. Environment variables win."""
    valori: dict[str, str] = {}
    percorso = Path(__file__).with_name(".env")
    if percorso.exists():
        for riga in percorso.read_text(encoding="utf-8").splitlines():
            riga = riga.strip()
            if not riga or riga.startswith("#") or "=" not in riga:
                continue
            chiave, _, valore = riga.partition("=")
            valori[chiave.strip()] = valore.strip().strip('"').strip("'")
    valori.update({k: v for k, v in os.environ.items() if k in valori or k.startswith("PISA_") or k.startswith("SHEET_") or k.startswith("GOOGLE_")})
    return valori


def richiedi(env: dict[str, str], chiave: str) -> str:
    valore = env.get(chiave, "")
    if not valore:
        sys.exit(f"Missing {chiave} in the .env file (copy .env.example and fill it in).")
    return valore


# --------------------------------------------------------------------------
# management-system API
# --------------------------------------------------------------------------

def login(email: str, password: str) -> str:
    risposta = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    if risposta.status_code == 401:
        sys.exit("Login rejected: invalid email or password.")
    risposta.raise_for_status()
    token = risposta.json().get("access_token")
    if not token:
        sys.exit(f"Login succeeded but no access_token. Response: {risposta.text[:300]}")
    return token


def scarica_depositi(token: str, hub_id: str | None = None) -> list[dict]:
    """Downloads every page of /admin/deposits."""
    intestazioni = {"Authorization": f"Bearer {token}"}
    depositi: list[dict] = []
    pagina = 1
    pagine_totali = 1

    while pagina <= pagine_totali:
        parametri = {"page": pagina, "pageSize": PAGE_SIZE}
        if hub_id:
            parametri["hubId"] = hub_id
        risposta = requests.get(
            f"{BASE_URL}/admin/deposits",
            params=parametri,
            headers=intestazioni,
            timeout=TIMEOUT,
        )
        risposta.raise_for_status()
        corpo = risposta.json()
        depositi.extend(corpo.get("items", []))
        pagine_totali = corpo.get("totalPages", 1) or 1
        print(f"  page {pagina}/{pagine_totali}, {len(depositi)} deposits so far", flush=True)
        pagina += 1

    return depositi


# --------------------------------------------------------------------------
# normalization
# --------------------------------------------------------------------------

def appiattisci(deposito: dict, prefisso: str = "") -> dict:
    """Flattens the nested object into one flat row: billing.dueNowEuro, etc."""
    piatto: dict = {}
    for chiave, valore in deposito.items():
        nome = f"{prefisso}{chiave}"
        if isinstance(valore, dict):
            piatto.update(appiattisci(valore, f"{nome}."))
        elif isinstance(valore, list):
            piatto[nome] = json.dumps(valore, ensure_ascii=False) if valore else ""
        else:
            piatto[nome] = valore
    return piatto


def costruisci_tabella(depositi: list[dict]) -> tuple[list[str], list[list]]:
    righe = [appiattisci(d) for d in depositi]

    presenti = {chiave for riga in righe for chiave in riga} - CAMPI_ESCLUSI
    colonne = [c for c in COLONNE_PREFERITE if c in presenti]
    colonne += sorted(c for c in presenti if c not in COLONNE_PREFERITE)

    # Computed column: tells us at a glance how many deposits can actually
    # get an email, which is the number the vault flags as unknown.
    colonne.append("haEmail")

    tabella = []
    for riga in righe:
        valori = []
        for colonna in colonne[:-1]:
            valore = riga.get(colonna, "")
            valori.append("" if valore is None else valore)
        email = str(riga.get("emailMittente") or "").strip()
        valori.append("si" if "@" in email else "no")
        tabella.append(valori)

    return colonne, tabella


def costruisci_lista_invio(depositi: list[dict]) -> tuple[list[str], list[list]]:
    """One address per person, not per deposit.

    Someone who left three bags in three lockers generated three rows with
    the same email: without dedup they would get three review requests. Not
    picked-up deposits are left out, since we do not ask for a review on
    those.
    """
    per_indirizzo: dict[str, dict] = {}

    for deposito in depositi:
        if deposito.get("status") != "picked_up":
            continue
        email = str(deposito.get("emailMittente") or "").strip()
        if "@" not in email:
            continue

        voce = per_indirizzo.setdefault(
            email.lower(),
            {"email": email, "locale": "", "depositi": 0, "ultimoRitiro": ""},
        )
        voce["depositi"] += 1

        # Dates are ISO 8601, so alphabetical order is also chronological.
        ritiro = str(deposito.get("pickupCompletedAt") or "")
        if ritiro > voce["ultimoRitiro"]:
            voce["ultimoRitiro"] = ritiro
            voce["locale"] = deposito.get("locale") or voce["locale"]

    colonne = ["email", "locale", "depositi", "ultimoRitiro"]
    righe = [
        [v["email"], v["locale"], v["depositi"], v["ultimoRitiro"]]
        for v in sorted(
            per_indirizzo.values(), key=lambda v: v["ultimoRitiro"], reverse=True
        )
    ]
    return colonne, righe


# --------------------------------------------------------------------------
# destinations
# --------------------------------------------------------------------------

def scrivi_csv(percorso: str, colonne: list[str], righe: list[list]) -> None:
    with open(percorso, "w", newline="", encoding="utf-8-sig") as f:
        scrittore = csv.writer(f, delimiter=";")
        scrittore.writerow(colonne)
        scrittore.writerows(righe)
    print(f"Wrote {len(righe)} rows to {percorso}")


def estrai_sheet_id(valore: str) -> str:
    """Accepts either the bare ID or the full URL copied from the browser bar."""
    if "/d/" in valore:
        return valore.split("/d/", 1)[1].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    return valore


def _scrivi_scheda(foglio, nome_scheda: str, colonne: list[str], righe: list[list], nota: str) -> None:
    import gspread

    try:
        scheda = foglio.worksheet(nome_scheda)
    except gspread.WorksheetNotFound:
        scheda = foglio.add_worksheet(
            title=nome_scheda, rows=len(righe) + 100, cols=len(colonne) + 5
        )

    intestazione = [nota] + [""] * (len(colonne) - 1)

    scheda.clear()
    scheda.update(values=[intestazione, colonne] + righe, range_name="A1")
    scheda.freeze(rows=2)

    print(f"Wrote {len(righe)} rows to the \"{nome_scheda}\" tab.")


def scrivi_google_sheet(
    env: dict[str, str],
    colonne: list[str],
    righe: list[list],
    colonne_invio: list[str],
    righe_invio: list[list],
) -> None:
    import gspread
    from google.oauth2.service_account import Credentials

    credenziali = Credentials.from_service_account_file(
        richiedi(env, "GOOGLE_SERVICE_ACCOUNT_JSON"),
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    client = gspread.authorize(credenziali)
    sheet_id = estrai_sheet_id(richiedi(env, "SHEET_ID"))
    foglio = client.open_by_key(sheet_id)

    aggiornato = datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %H:%M")

    _scrivi_scheda(
        foglio,
        env.get("SHEET_TAB", "Depositi Pisa"),
        colonne,
        righe,
        f"Updated on {aggiornato}, {len(righe)} deposits",
    )
    _scrivi_scheda(
        foglio,
        env.get("SHEET_TAB_INVII", "Lista invio"),
        colonne_invio,
        righe_invio,
        f"Updated on {aggiornato}, {len(righe_invio)} distinct addresses, one pickup each",
    )

    print(f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit")


# --------------------------------------------------------------------------

def riepiloga(depositi: list[dict]) -> None:
    stati: dict[str, int] = {}
    ritirati = 0
    ritirati_con_email = 0
    indirizzi: set[str] = set()

    for deposito in depositi:
        stato = deposito.get("status", "?")
        stati[stato] = stati.get(stato, 0) + 1
        email = str(deposito.get("emailMittente") or "").strip().lower()
        if "@" in email:
            indirizzi.add(email)
        if stato == "picked_up":
            ritirati += 1
            if "@" in email:
                ritirati_con_email += 1

    print(f"\nTotal deposits: {len(depositi)}")
    for stato, quanti in sorted(stati.items(), key=lambda x: -x[1]):
        print(f"  {stato}: {quanti}")

    quota = (ritirati_con_email / ritirati * 100) if ritirati else 0
    print(f"\nPicked up with email: {ritirati_con_email} of {ritirati} ({quota:.0f}%)")
    print(f"Distinct addresses: {len(indirizzi)}")
    print("  ^ this is the real pool for review requests, net of duplicates.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pisa deposits export")
    parser.add_argument("--schema", action="store_true", help="prints the fields returned by the API")
    parser.add_argument("--dry-run", action="store_true", help="downloads and summarizes without writing")
    parser.add_argument("--csv", metavar="FILE", help="writes a CSV instead of the Google Sheet")
    argomenti = parser.parse_args()

    env = carica_env()
    print("Logging into the management system...", flush=True)
    token = login(richiedi(env, "PISA_EMAIL"), richiedi(env, "PISA_PASSWORD"))

    print("Downloading deposits...", flush=True)
    depositi = scarica_depositi(token, env.get("PISA_HUB_ID") or None)

    if not depositi:
        sys.exit("No deposits returned by the API: check the account and the hub.")

    if argomenti.schema:
        print("\nFields of the first deposit (sensitive fields are masked):\n")
        campione = {
            chiave: ("***" if chiave in CAMPI_ESCLUSI else valore)
            for chiave, valore in appiattisci(depositi[0]).items()
        }
        print(json.dumps(campione, indent=2, ensure_ascii=False, default=str))
        riepiloga(depositi)
        return

    colonne, righe = costruisci_tabella(depositi)
    colonne_invio, righe_invio = costruisci_lista_invio(depositi)
    riepiloga(depositi)

    if argomenti.dry_run:
        print(f"\n[dry-run] {len(righe)} rows x {len(colonne)} columns, not written.")
        print(f"[dry-run] send list: {len(righe_invio)} addresses, not written.")
        print("Columns: " + ", ".join(colonne))
        return

    if argomenti.csv:
        scrivi_csv(argomenti.csv, colonne, righe)
        percorso = Path(argomenti.csv)
        scrivi_csv(
            str(percorso.with_stem(percorso.stem + "-lista-invio")),
            colonne_invio,
            righe_invio,
        )
    else:
        scrivi_google_sheet(env, colonne, righe, colonne_invio, righe_invio)


if __name__ == "__main__":
    main()
