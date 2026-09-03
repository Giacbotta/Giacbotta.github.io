"""
Export of the takings of the Venezia site from the PromoTec panel.

Source: https://panel.kiosk-vendor.example/ , "Counters" page, table of counter
records. One row per transaction: date, amount VAT included, locker,
receipt number, discount.

Careful, two limits that come from the source and cannot be worked around:

  1. The panel keeps **only three months**. Whatever is not downloaded is
     lost: that is why the script accumulates in a local archive instead of
     rewriting (unlike its twin in Pisa, where the API has everything).
  2. There are no emails, no deposit times, no locker size.
     The row is created at the moment of payment. For the Venezia review
     requests this source is useless.

The panel is ASP.NET WebForms: no API, no JSON. You navigate by postback,
carrying __VIEWSTATE and __EVENTVALIDATION along at every step.

**The pages are served in two stages.** The first response is an empty
skeleton that carries at the bottom a <script> with __doPostBack('__Page','PBArg'):
the browser runs it and makes a second postback, and that is the one that fills
the month dropdown and the 56 locker buttons. Whoever stops at the first
response sees a page with no data and believes the panel has changed.
It cost us a session, on 18/08/2026. posta() takes care of it.
The script never presses the locker buttons, or Unbook All, or Reboot, or
Open Ex.Door: it opens Counters and reads.

Use:
    python export_incassi.py --dry-run          # log in, list the months, write nothing
    python export_incassi.py                    # download every available month
    python export_incassi.py --mese 07/2026     # one month only
    python export_incassi.py --diagnosi         # test the chain and say where it breaks
    python export_incassi.py --tentativi 8      # insist harder if the panel plays up
    python export_incassi.py --archivio FILE    # where to accumulate (default archivio-incassi.csv)

The panel is intermittent: the same request answers in half a minute or does
not answer at all. The script retries by itself, with a fresh session on every
attempt. One failed run is not news, three in a row are.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path

import requests

BASE_URL = "https://panel.kiosk-vendor.example/"
API_URL = "https://panel.kiosk-vendor.example/lockers.asmx"

# The panel is slow when the kiosk struggles: between 20 and 21/08/2026 single steps
# took between 95 and 170 seconds. With the old ceiling of 60 the script
# died in ReadTimeout before the server answered, and the error looked like
# a fault of ours instead of a block downstream.
TIMEOUT = int(os.environ.get("PROMOTEC_TIMEOUT", "240"))

# The panel goes to sleep: see sveglia_pannello().
SVEGLIE = 4
PAUSA_SVEGLIA = 10
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# The buttons that must never be pressed, for any reason: they open doors in
# Cannaregio or clear the bookings. Listed as a reminder, not for use.
BOTTONI_PROIBITI = {"BtnUnbookAll", "BtnReboot", "BtnOpenEx"}

COLONNE = ["mese", "data", "importoIvaInclusa", "cassetto", "scontrino", "sconto"]


# --------------------------------------------------------------------------
# reading the HTML
# --------------------------------------------------------------------------

class Pagina(HTMLParser):
    """Extracts from a WebForms page the form fields, the select options
    and the rows of the first table. No external dependencies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.campi: dict[str, str] = {}          # name -> value, hidden/text only
        self.tipi: dict[str, str] = {}           # name -> type of the input
        self.bottoni: list[tuple[str, str]] = []  # (name, value) of the submits
        self.select_corrente: str | None = None
        self.opzioni: dict[str, list[str]] = {}   # name of the select -> values
        self.tabelle: list[list[list[str]]] = []
        self._tabella: list[list[str]] | None = None
        self._riga: list[str] | None = None
        self._cella: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)

        if tag == "input":
            nome = a.get("name")
            if not nome:
                return
            tipo = (a.get("type") or "text").lower()
            self.tipi[nome] = tipo
            if tipo == "submit":
                self.bottoni.append((nome, a.get("value", "")))
            elif tipo in ("hidden", "text", "password"):
                self.campi[nome] = a.get("value", "")

        elif tag == "select":
            self.select_corrente = a.get("name")
            if self.select_corrente:
                self.opzioni[self.select_corrente] = []

        elif tag == "option" and self.select_corrente:
            valore = a.get("value")
            if valore is not None:
                self.opzioni[self.select_corrente].append(valore)
            if "selected" in a and valore is not None:
                self.campi[self.select_corrente] = valore

        elif tag == "table":
            self._tabella = []
        elif tag == "tr" and self._tabella is not None:
            self._riga = []
        elif tag in ("td", "th") and self._riga is not None:
            self._cella = []

    def handle_endtag(self, tag):
        if tag == "select":
            self.select_corrente = None
        elif tag in ("td", "th") and self._cella is not None:
            self._riga.append("".join(self._cella).strip())
            self._cella = None
        elif tag == "tr" and self._riga is not None:
            if self._riga:
                self._tabella.append(self._riga)
            self._riga = None
        elif tag == "table" and self._tabella is not None:
            if self._tabella:
                self.tabelle.append(self._tabella)
            self._tabella = None

    def handle_data(self, dato):
        if self._cella is not None:
            self._cella.append(dato)

    # -- convenience -------------------------------------------------------

    def bottone_con_valore(self, testo: str) -> tuple[str, str] | None:
        """Finds a submit from the text written on it, ignoring case.

        It looks for the exact match first, then falls back to substring.
        The order is mandatory: "Luggage Cannaregio" is contained in "Luggage
        Cannaregio cloud", and a loose match would pick the wrong system
        without saying so.
        """
        testo = testo.strip().lower()
        for nome, valore in self.bottoni:
            if valore.strip().lower() == testo:
                return nome, valore
        for nome, valore in self.bottoni:
            if testo in valore.lower():
                return nome, valore
        return None

    def bottone_con_nome(self, frammento: str) -> tuple[str, str] | None:
        frammento = frammento.lower()
        for nome, valore in self.bottoni:
            if frammento in nome.lower():
                return nome, valore
        return None

    def campo_di_tipo(self, frammento: str) -> str | None:
        for nome in self.campi:
            if frammento.lower() in nome.lower():
                return nome
        return None

    def campo_password(self) -> str | None:
        """Looked up by type, not by name: on the panel it is called "txtSysPsw",
        which does not contain the word "password"."""
        for nome, tipo in self.tipi.items():
            if tipo == "password":
                return nome
        return None


def leggi(html: str) -> Pagina:
    p = Pagina()
    p.feed(html)
    return p


def stato_form(pagina: Pagina) -> dict[str, str]:
    """The fields every postback has to carry back: viewstate and company."""
    return {
        nome: valore for nome, valore in pagina.campi.items()
        if nome.startswith("__") or nome == "monthList"
    }


# The <script> at the end of the pages that arrive empty. See the note at the top.
AUTO_POSTBACK = re.compile(r"__doPostBack\(\s*'__Page'\s*,\s*'PBArg'\s*\)")


class TotemFermo(Exception):
    """The panel answers but the data does not arrive.

    It is not a fault of the script nor a change in the panel: it is the
    Cannaregio kiosk not answering whoever asks it. The pages served by the web
    application alone (login, system choice, month dropdown) keep working,
    while everything that has to reach the kiosk falls into a 500 or into a
    timeout. Verified between 2026-08-20 and 2026-08-21.
    """


def manda(sessione: requests.Session, dati: dict[str, str], passo: str) -> str:
    """A single POST, with the error translated into a sentence you can understand."""
    try:
        risposta = sessione.post(BASE_URL, data=dati, timeout=TIMEOUT)
    except requests.Timeout:
        raise TotemFermo(f"{passo}: no answer within {TIMEOUT}s")
    except requests.RequestException as errore:
        raise TotemFermo(f"{passo}: {type(errore).__name__}")

    if risposta.status_code >= 500:
        raise TotemFermo(f"{passo}: the panel answered {risposta.status_code}")

    risposta.raise_for_status()
    return risposta.text


def posta(sessione: requests.Session, dati: dict[str, str],
          seguito: bool = True, passo: str = "postback") -> Pagina:
    """A postback and its follow-up.

    Sends the data, then as long as the response asks for the auto-postback it
    redoes it in place of the browser. The ceiling of three rounds exists only
    to avoid an infinite loop if one day the panel asked for it forever: as of
    2026-08-19 one is always enough.

    With seguito=False the auto-postback is skipped: useful where the follow-up
    fills only things we do not care about, and it is the first step to fall
    when the kiosk does not answer.
    """
    html = manda(sessione, dati, passo)
    if not seguito:
        return leggi(html)

    for _ in range(3):
        if not AUTO_POSTBACK.search(html):
            break
        campi = stato_form(leggi(html))
        campi["__EVENTTARGET"] = "__Page"
        campi["__EVENTARGUMENT"] = "PBArg"
        html = manda(sessione, campi, f"{passo}, auto-postback")

    return leggi(html)


# --------------------------------------------------------------------------
# navigating the panel
# --------------------------------------------------------------------------

def sveglia_pannello(sessione: requests.Session) -> None:
    """Knocks at the panel until it answers, before starting for real.

    kiosk-vendor.example shuts the application down after a period of inactivity and
    restarts it on the first request: whoever knocks while it is waking up hangs
    and times out. Measured on 2026-08-19, six calls in a row from cold:
    timeout at 25s, then 12.3s, 7.8s, 2.7s, 3.8s, 0.5s.

    These calls are thrown away: the result is not what matters, what matters is
    that the application restarts while nobody depends on it yet.
    """
    for tentativo in range(1, SVEGLIE + 1):
        try:
            risposta = sessione.get(BASE_URL, timeout=TIMEOUT)
            if risposta.status_code == 200:
                if tentativo > 1:
                    print(f"Panel awake at call {tentativo}.")
                return
            print(f"Wake-up {tentativo}: the panel answered {risposta.status_code}.")
        except requests.RequestException as errore:
            print(f"Wake-up {tentativo}: {type(errore).__name__}, it was asleep.")
        time.sleep(PAUSA_SVEGLIA)

    print("The panel did not answer the wake-up calls: trying anyway.")


def entra(sessione: requests.Session, utente: str, password: str | None, sistema: str) -> Pagina:
    """Login in two screens.

    1. "User Name" -> field txtUserName, button btnSelecUser.
    2. "System password" -> field txtSysPsw, plus THREE system buttons:
       btnSelectSystem_1 "Luggage Cannaregio cloud"
       btnSelectSystem_2 "Luggage Cannaregio"
       btnSelectSystem_3 "Luggage Cannaregio Dyn"  <- the one in use
       The password and the system choice travel in the same POST, the way
       the browser does it when you type the password and press the button.
    """
    risposta = sessione.get(BASE_URL, timeout=TIMEOUT)
    risposta.raise_for_status()
    pagina = leggi(risposta.text)

    campo_utente = pagina.campo_di_tipo("user") or pagina.campo_di_tipo("txt")
    bottone = pagina.bottone_con_valore("select") or (pagina.bottoni[0] if pagina.bottoni else None)
    if not campo_utente or not bottone:
        sys.exit("Unexpected login page: cannot find the user field or the Select button.")

    dati = stato_form(pagina)
    dati[campo_utente] = utente
    dati[bottone[0]] = bottone[1]

    pagina = posta(sessione, dati)

    # Second step: system password and choice of system.
    campo_password = pagina.campo_password()
    if campo_password:
        if not password:
            sys.exit(
                "The panel is asking for the System password but PROMOTEC_PASSWORD is not set.\n"
                "Put it in the .env file next to this script."
            )

        bottone = pagina.bottone_con_valore(sistema)
        if not bottone:
            disponibili = [v for _, v in pagina.bottoni if v.lower() != "exit"]
            sys.exit(
                f"System \"{sistema}\" not found in the selection screen.\n"
                f"The available ones are: {', '.join(disponibili)}.\n"
                "Fix PROMOTEC_SISTEMA in the .env file."
            )

        dati = stato_form(pagina)
        dati[campo_password] = password
        dati[bottone[0]] = bottone[1]

        # Without follow-up: the auto-postback of the menu only draws the 56
        # locker buttons, which we never press, and on 21/08/2026 it is the
        # first step to fall when the kiosk does not answer. The "Counters"
        # button is already in the skeleton, together with the other four
        # commands. If one day it were not there, the follow-up is redone below.
        pagina = posta(sessione, dati, seguito=False, passo="system choice")

        if not pagina.bottone_con_valore("counters"):
            campi = stato_form(pagina)
            campi["__EVENTTARGET"] = "__Page"
            campi["__EVENTARGUMENT"] = "PBArg"
            pagina = posta(sessione, campi, seguito=False, passo="full menu")

    if not pagina.bottone_con_valore("counters"):
        sys.exit(
            "Login failed: after signing in I cannot find the \"Counters\" button.\n"
            "Check user, System password and system name, or else the\n"
            "panel has changed."
        )

    return pagina


def apri_counters(sessione: requests.Session, pagina: Pagina) -> Pagina:
    bottone = pagina.bottone_con_valore("counters")
    if not bottone:
        sys.exit("The \"Counters\" button has gone from the menu.")

    dati = stato_form(pagina)
    dati[bottone[0]] = bottone[1]

    return posta(sessione, dati)


def scarica_mese(sessione: requests.Session, pagina: Pagina, mese: str) -> tuple[Pagina, list[list[str]]]:
    """Selects a month and presses "Get Incoming". Returns the new page, which
    is needed for the next postback, and the rows read."""
    bottone = pagina.bottone_con_nome("GetCounterRecords") or pagina.bottone_con_valore("incoming")
    if not bottone:
        sys.exit("Cannot find the \"Get Incoming\" button in the Counters page.")

    dati = stato_form(pagina)
    dati["monthList"] = mese
    dati[bottone[0]] = bottone[1]

    nuova = posta(sessione, dati)

    righe: list[list[str]] = []
    for tabella in nuova.tabelle:
        if not tabella:
            continue
        intestazione = [c.upper() for c in tabella[0]]
        if "DATE" in intestazione and any("TOTAL" in c for c in intestazione):
            righe = tabella[1:]
            break

    return nuova, righe


# --------------------------------------------------------------------------
# archive
# --------------------------------------------------------------------------

def carica_archivio(percorso: Path) -> dict[str, list[str]]:
    """The archive is indexed by receipt number, which the panel does not
    reuse. That way reading a month twice duplicates nothing."""
    esistenti: dict[str, list[str]] = {}
    if not percorso.exists():
        return esistenti

    with percorso.open(encoding="utf-8-sig", newline="") as f:
        for riga in csv.reader(f, delimiter=";"):
            if not riga or riga[0] == "mese":
                continue
            if len(riga) >= 5:
                esistenti[riga[4]] = riga
    return esistenti


def salva_archivio(percorso: Path, righe: dict[str, list[str]]) -> None:
    ordinate = sorted(righe.values(), key=lambda r: r[1])
    with percorso.open("w", encoding="utf-8-sig", newline="") as f:
        scrittore = csv.writer(f, delimiter=";")
        scrittore.writerow(COLONNE)
        scrittore.writerows(ordinate)
    print(f"Archive updated: {len(ordinate)} transactions in {percorso}")


# --------------------------------------------------------------------------

def carica_env() -> dict[str, str]:
    valori: dict[str, str] = {}
    percorso = Path(__file__).with_name(".env")
    if percorso.exists():
        for riga in percorso.read_text(encoding="utf-8").splitlines():
            riga = riga.strip()
            if not riga or riga.startswith("#") or "=" not in riga:
                continue
            chiave, _, valore = riga.partition("=")
            valori[chiave.strip()] = valore.strip().strip('"').strip("'")
    for chiave in ("PROMOTEC_USER", "PROMOTEC_PASSWORD", "PROMOTEC_SISTEMA"):
        if os.environ.get(chiave):
            valori[chiave] = os.environ[chiave]
    return valori


# --------------------------------------------------------------------------
# diagnosis
# --------------------------------------------------------------------------

# The only API operations that may be called: they read and nothing else. The
# other nine open lockers and reboot the system, with no confirmation in front.
API_CONSENTITE = {"getLockersState", "Proceeds", "History"}


def chiedi_api(env: dict[str, str], operazione: str, extra: dict[str, str] | None = None) -> str:
    """One call to the kiosk API, on the HTTP POST binding.

    POST and not GET: this way key and mastercode stay in the body and do not
    end up in the URL, where the server and proxy logs would record them.
    """
    if operazione not in API_CONSENTITE:
        raise ValueError(f"operation not allowed: {operazione}")

    mancanti = [c for c in ("VENEZIA_API_KEY", "VENEZIA_RECIPIENT", "VENEZIA_MASTERCODE")
                if not env.get(c)]
    if mancanti:
        return f"not tested, missing from .env: {', '.join(mancanti)}"

    dati = {
        "key": env["VENEZIA_API_KEY"],
        "recipient": env["VENEZIA_RECIPIENT"],
        "port": env.get("VENEZIA_PORT", "11000"),
        "mastercode": env["VENEZIA_MASTERCODE"],
    }
    dati.update(extra or {})

    try:
        risposta = requests.post(f"{API_URL}/{operazione}", data=dati,
                                 timeout=TIMEOUT, headers={"User-Agent": UA})
    except requests.RequestException as errore:
        return f"{type(errore).__name__}"

    testo = re.sub(r"<[^>]+>", " ", risposta.text)
    testo = re.sub(r"\s+", " ", testo).strip()
    return f"HTTP {risposta.status_code}: {testo[:160]}"


def diagnosi(sessione: requests.Session, env: dict[str, str]) -> None:
    """The six tests that say where it breaks, in one go.

    It exists to answer in two minutes the only question that matters when the
    export fails: has the panel changed, or is the kiosk not answering? On
    21/08/2026 the answer changed twice in an hour, and getting there had taken
    half a session.
    """
    utente = env.get("PROMOTEC_USER", "nutrie")
    password = env.get("PROMOTEC_PASSWORD") or None
    sistema = env.get("PROMOTEC_SISTEMA") or "Luggage Cannaregio Dyn"

    esiti: list[tuple[str, str]] = []
    mesi: list[str] = []
    dati_letti = False

    sveglia_pannello(sessione)
    try:
        menu = entra(sessione, utente, password, sistema)
        esiti.append(("login and system choice", f"ok, {len(menu.bottoni)} buttons"))

        counters = apri_counters(sessione, menu)
        mesi = counters.opzioni.get("monthList", [])
        esiti.append(("Counters page", f"ok, months {', '.join(mesi) if mesi else 'none'}"))

        if mesi:
            inizio = time.time()
            _, righe = scarica_mese(sessione, counters, mesi[0])
            dati_letti = bool(righe)
            esiti.append((f"download of {mesi[0]}",
                          f"{len(righe)} rows in {time.time() - inizio:.0f}s"))
    except TotemFermo as fermo:
        esiti.append(("reading the data", f"FAILED: {fermo}"))
    except SystemExit as uscita:
        esiti.append(("navigation", f"FAILED: {uscita}"))

    esiti.append(("API getLockersState", chiedi_api(env, "getLockersState")))

    print("\nDiagnosis:")
    for passo, esito in esiti:
        print(f"  {passo}: {esito}")

    print("\nVerdict:")
    if dati_letti:
        print("  The panel works and the data arrives. The export can run.")
    elif mesi:
        print("  The panel answers and knows the months, but the records do not arrive.")
        print("  The panel has not changed: it is the kiosk that is not answering")
        print("  whoever asks it for the transactions. Same symptom as the API.")
        print("  There is nothing to fix in the script: try again later.")
    else:
        print("  We do not even get to the list of months. If the login goes")
        print("  through, the block is downstream; if not, check the credentials.")


TENTATIVI = 4
PAUSA_TENTATIVI = 90


def con_pazienza(env: dict[str, str], mese: str | None, tentativi: int = TENTATIVI,
                 solo_elenco: bool = False):
    """Redoes the run until the data arrives, or until the attempts run out.

    The panel is **intermittent**, measured on 21/08/2026: the same request
    answered in 29 seconds and, ten minutes later, did not answer at all
    within 240. A single run says nothing about the state of the system, it
    only says whether you were lucky.

    Every attempt starts from a fresh session: cookies and viewstate of a
    half-dead session are not recycled. What has already been read stays read,
    so two half attempts still add up to a whole month.
    """
    letti: dict[str, list[list[str]]] = {}
    mesi: list[str] = []

    for tentativo in range(1, tentativi + 1):
        if tentativo > 1:
            print(f"\nAttempt {tentativo} of {tentativi}, in {PAUSA_TENTATIVI}s...")
            time.sleep(PAUSA_TENTATIVI)

        sessione = requests.Session()
        sessione.headers.update({"User-Agent": UA})

        try:
            sveglia_pannello(sessione)
            menu = entra(sessione, env.get("PROMOTEC_USER", "nutrie"),
                         env.get("PROMOTEC_PASSWORD") or None,
                         env.get("PROMOTEC_SISTEMA") or "Luggage Cannaregio Dyn")
            counters = apri_counters(sessione, menu)
            mesi = counters.opzioni.get("monthList", [])
            if not mesi:
                print("  the month dropdown is empty: trying again.")
                continue

            if solo_elenco:
                return letti, mesi, []

            if mese is not None and mese not in mesi:
                sys.exit(f"Month {mese} is not among the available ones: {', '.join(mesi)}")

            da_leggere = [m for m in ([mese] if mese else mesi) if m not in letti]
            for m in da_leggere:
                counters, righe = scarica_mese(sessione, counters, m)
                if righe:
                    letti[m] = righe
                    print(f"  {m}: read, {len(righe)} rows.")
                else:
                    print(f"  {m}: the table came back empty, trying again later.")

            if all(m in letti for m in ([mese] if mese else mesi)):
                return letti, mesi, []

        except TotemFermo as fermo:
            print(f"  attempt {tentativo}: {fermo}")

    if not mesi:
        return None

    falliti = [m for m in ([mese] if mese else mesi) if m not in letti]
    if not letti:
        return None
    return letti, mesi, falliti


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="log in and show the months, without writing")
    parser.add_argument("--diagnosi", action="store_true",
                        help="test the whole chain and say where it breaks, without writing")
    parser.add_argument("--mese", help="one month only, format MM/YYYY")
    parser.add_argument("--tentativi", type=int, default=TENTATIVI,
                        help=f"how many times to retry if the panel does not answer (default {TENTATIVI})")
    parser.add_argument("--archivio", default=str(Path(__file__).with_name("archivio-incassi.csv")))
    argomenti = parser.parse_args()

    # User, password and system are read by con_pazienza(), which rebuilds the
    # session from scratch on every attempt.
    env = carica_env()

    if argomenti.diagnosi:
        sessione = requests.Session()
        sessione.headers.update({"User-Agent": UA})
        diagnosi(sessione, env)
        return

    if argomenti.dry_run:
        esito = con_pazienza(env, None, argomenti.tentativi, solo_elenco=True)
        if esito is None:
            raise TotemFermo(f"no month read in {argomenti.tentativi} attempts")
        print(f"Months available on the panel: {', '.join(esito[1])}")
        print("  ^ the panel keeps only three: the older ones are already lost.")
        return

    percorso = Path(argomenti.archivio)
    archivio = carica_archivio(percorso)
    prima = len(archivio)

    esito = con_pazienza(env, argomenti.mese, argomenti.tentativi)
    if esito is None:
        raise TotemFermo(f"no data in {argomenti.tentativi} attempts")

    letti, mesi, falliti = esito
    for mese, righe in letti.items():
        totale = 0.0
        for riga in righe:
            if len(riga) < 5:
                continue
            data, importo, cassetto, scontrino, sconto = riga[:5]
            archivio[scontrino] = [mese, data, importo, cassetto, scontrino, sconto]
            try:
                totale += float(importo)
            except ValueError:
                pass
        print(f"  {mese}: {len(righe)} transactions, {totale:.2f} EUR")

    salva_archivio(percorso, archivio)
    print(f"New compared to the archive: {len(archivio) - prima}")

    if falliti:
        print(
            f"\nWARNING: {', '.join(falliti)} was not read. The panel\n"
            "keeps only three months: if it falls behind until they expire, that\n"
            "data disappears. Run it again later, the archive duplicates nothing."
        )


if __name__ == "__main__":
    try:
        main()
    except TotemFermo as fermo:
        sys.exit(
            f"The panel did not give the data: {fermo}\n\n"
            "The panel is intermittent: on 21/08/2026 the same request answered\n"
            "in 29 seconds and ten minutes later did not answer at all.\n"
            "If it failed even after all the attempts, there is nothing to fix\n"
            "here: run it again later, the archive does not duplicate.\n\n"
            "To see where it breaks:\n"
            "    python export_incassi.py --diagnosi\n"
            "To insist harder:\n"
            "    python export_incassi.py --tentativi 8"
        )
