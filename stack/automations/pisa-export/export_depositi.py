"""
Export giornaliero dei depositi della sede di Pisa su Google Sheet.

Sorgente: API del gestionale Onniversum (api.locker-vendor.example/api),
tenant Self Luggage Storage Pisa (HUB-001).

Il foglio viene riscritto per intero a ogni esecuzione, quindi e' sempre uno
specchio del pannello: se un giorno la macchina e' spenta, la corsa successiva
recupera da sola i giorni mancanti. Nessuno stato viene tenuto in locale.

Uso:
    python export_depositi.py --schema     # stampa i campi che l'API restituisce
    python export_depositi.py --dry-run    # scarica e riepiloga, non scrive nulla
    python export_depositi.py --csv out.csv
    python export_depositi.py              # scrive sul Google Sheet
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
PAGE_SIZE = 100  # tetto imposto dal server: valori piu' alti vengono troncati
TIMEOUT = 30

# Campi che NON devono finire sul foglio. pickupCode e' il codice che apre il
# cassetto e apiKey e' la chiave del chiosco: su un foglio che puo' essere
# condiviso non ci vanno. Gli altri sono rumore tecnico.
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

# Colonne note, nell'ordine in cui vogliamo leggerle. I campi che l'API
# restituisce e che non sono in questa lista vengono aggiunti in coda, cosi'
# se il fornitore ne introduce di nuovi non li perdiamo in silenzio.
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
# configurazione
# --------------------------------------------------------------------------

def carica_env() -> dict[str, str]:
    """Legge il file .env accanto allo script. Le variabili d'ambiente vincono."""
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
        sys.exit(f"Manca {chiave} nel file .env (copia .env.example e compilalo).")
    return valore


# --------------------------------------------------------------------------
# API del gestionale
# --------------------------------------------------------------------------

def login(email: str, password: str) -> str:
    risposta = requests.post(
        f"{BASE_URL}/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    if risposta.status_code == 401:
        sys.exit("Login rifiutato: email o password non validi.")
    risposta.raise_for_status()
    token = risposta.json().get("access_token")
    if not token:
        sys.exit(f"Login riuscito ma senza access_token. Risposta: {risposta.text[:300]}")
    return token


def scarica_depositi(token: str, hub_id: str | None = None) -> list[dict]:
    """Scarica tutte le pagine di /admin/deposits."""
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
        print(f"  pagina {pagina}/{pagine_totali} — {len(depositi)} depositi finora", flush=True)
        pagina += 1

    return depositi


# --------------------------------------------------------------------------
# normalizzazione
# --------------------------------------------------------------------------

def appiattisci(deposito: dict, prefisso: str = "") -> dict:
    """Riduce l'oggetto annidato a una riga piatta: billing.dueNowEuro, ecc."""
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

    # Colonna calcolata: serve a sapere subito su quanti depositi si puo'
    # davvero mandare una mail, che e' il numero che il vault segnala ignoto.
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
    """Un indirizzo per persona, non per deposito.

    Chi ha lasciato tre bagagli in tre cassetti ha generato tre righe con la
    stessa email: senza dedup riceverebbe tre richieste di recensione. Restano
    fuori i depositi non ritirati, a cui una recensione non si chiede.
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

        # Le date sono ISO 8601, quindi l'ordine alfabetico e' anche cronologico.
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
# destinazioni
# --------------------------------------------------------------------------

def scrivi_csv(percorso: str, colonne: list[str], righe: list[list]) -> None:
    with open(percorso, "w", newline="", encoding="utf-8-sig") as f:
        scrittore = csv.writer(f, delimiter=";")
        scrittore.writerow(colonne)
        scrittore.writerows(righe)
    print(f"Scritte {len(righe)} righe in {percorso}")


def estrai_sheet_id(valore: str) -> str:
    """Accetta sia l'ID nudo sia l'URL completo copiato dalla barra del browser."""
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

    print(f"Scritte {len(righe)} righe nella scheda «{nome_scheda}».")


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
        f"Aggiornato il {aggiornato} — {len(righe)} depositi",
    )
    _scrivi_scheda(
        foglio,
        env.get("SHEET_TAB_INVII", "Lista invio"),
        colonne_invio,
        righe_invio,
        f"Aggiornato il {aggiornato} — {len(righe_invio)} indirizzi distinti, un ritiro a testa",
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

    print(f"\nDepositi totali: {len(depositi)}")
    for stato, quanti in sorted(stati.items(), key=lambda x: -x[1]):
        print(f"  {stato}: {quanti}")

    quota = (ritirati_con_email / ritirati * 100) if ritirati else 0
    print(f"\nRitirati con email: {ritirati_con_email} su {ritirati} ({quota:.0f}%)")
    print(f"Indirizzi distinti: {len(indirizzi)}")
    print("  ^ e' il bacino reale di richieste di recensione, al netto dei doppioni.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export depositi Pisa")
    parser.add_argument("--schema", action="store_true", help="stampa i campi restituiti dall'API")
    parser.add_argument("--dry-run", action="store_true", help="scarica e riepiloga senza scrivere")
    parser.add_argument("--csv", metavar="FILE", help="scrive un CSV invece del Google Sheet")
    argomenti = parser.parse_args()

    env = carica_env()
    print("Login sul gestionale...", flush=True)
    token = login(richiedi(env, "PISA_EMAIL"), richiedi(env, "PISA_PASSWORD"))

    print("Scarico i depositi...", flush=True)
    depositi = scarica_depositi(token, env.get("PISA_HUB_ID") or None)

    if not depositi:
        sys.exit("Nessun deposito restituito dall'API: controlla l'account e l'hub.")

    if argomenti.schema:
        print("\nCampi del primo deposito (i campi sensibili sono oscurati):\n")
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
        print(f"\n[dry-run] {len(righe)} righe x {len(colonne)} colonne, non scritte.")
        print(f"[dry-run] lista invio: {len(righe_invio)} indirizzi, non scritti.")
        print("Colonne: " + ", ".join(colonne))
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
