"""
Export degli incassi della sede di Venezia dal pannello PromoTec.

Sorgente: https://panel.kiosk-vendor.example/ , pagina «Counters», tabella dei record
contatore. Una riga per transazione: data, importo IVA inclusa, cassetto,
numero di scontrino, sconto.

Attenzione, due limiti che vengono dalla sorgente e non si aggirano:

  1. Il pannello conserva **solo tre mesi**. Quello che non si scarica, si
     perde: per questo lo script accumula in un archivio locale invece di
     riscrivere (al contrario del gemello di Pisa, dove l'API ha tutto).
  2. Non ci sono email, ne' orari di deposito, ne' taglia del cassetto.
     La riga nasce al momento del pagamento. Per le richieste di recensione
     di Venezia questa fonte non serve.

Il pannello e' ASP.NET WebForms: niente API, niente JSON. Si naviga a
postback, portandosi dietro __VIEWSTATE e __EVENTVALIDATION a ogni passo.

**Le pagine si servono in due tempi.** La prima risposta e' uno scheletro
vuoto che in fondo porta uno <script> con __doPostBack('__Page','PBArg'): il
browser lo esegue e fa un secondo postback, ed e' quello che riempie la
tendina dei mesi e i 56 bottoni dei cassetti. Chi si ferma alla prima
risposta vede una pagina senza dati e crede che il pannello sia cambiato.
Ci e' costato una sessione, il 18/08/2026. Ci pensa posta().
Lo script non preme mai i bottoni dei cassetti, di Unbook All, di Reboot o
di Open Ex.Door: apre solo Counters e legge.

Uso:
    python export_incassi.py --dry-run          # entra, elenca i mesi, non scrive
    python export_incassi.py                    # scarica tutti i mesi disponibili
    python export_incassi.py --mese 07/2026     # un mese solo
    python export_incassi.py --diagnosi         # prova la catena e dice dove si rompe
    python export_incassi.py --tentativi 8      # insiste di piu' se il pannello fa i capricci
    python export_incassi.py --archivio FILE    # dove accumulare (default archivio-incassi.csv)

Il pannello e' intermittente: la stessa richiesta risponde in mezzo minuto o
non risponde affatto. Lo script riprova da solo, con una sessione nuova a ogni
tentativo. Una corsa fallita non e' una notizia, tre di fila lo sono.
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

# Il pannello e' lento quando il totem fatica: fra il 20 e il 21/08/2026 i singoli passi
# hanno impiegato fra 95 e 170 secondi. Con il vecchio tetto di 60 lo script
# moriva in ReadTimeout prima che il server rispondesse, e l'errore sembrava
# un difetto nostro invece che un blocco a valle.
TIMEOUT = int(os.environ.get("PROMOTEC_TIMEOUT", "240"))

# Il pannello va in letargo: vedi sveglia_pannello().
SVEGLIE = 4
PAUSA_SVEGLIA = 10
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# I bottoni che non vanno premuti mai, per nessun motivo: aprono sportelli a
# Cannaregio o azzerano le prenotazioni. Elencati per memoria, non per uso.
BOTTONI_PROIBITI = {"BtnUnbookAll", "BtnReboot", "BtnOpenEx"}

COLONNE = ["mese", "data", "importoIvaInclusa", "cassetto", "scontrino", "sconto"]


# --------------------------------------------------------------------------
# lettura dell'HTML
# --------------------------------------------------------------------------

class Pagina(HTMLParser):
    """Estrae da una pagina WebForms i campi del form, le opzioni delle select
    e le righe della prima tabella. Niente dipendenze esterne."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.campi: dict[str, str] = {}          # name -> value, solo hidden/text
        self.tipi: dict[str, str] = {}           # name -> type dell'input
        self.bottoni: list[tuple[str, str]] = []  # (name, value) dei submit
        self.select_corrente: str | None = None
        self.opzioni: dict[str, list[str]] = {}   # name della select -> valori
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

    # -- comodita' ---------------------------------------------------------

    def bottone_con_valore(self, testo: str) -> tuple[str, str] | None:
        """Trova un submit dal testo che ci sta scritto sopra, senza badare a
        maiuscole.

        Prima cerca la corrispondenza esatta, poi ripiega sul contenuto. Ordine
        obbligatorio: «Luggage Cannaregio» e' contenuto dentro «Luggage
        Cannaregio cloud», e un match approssimativo sceglierebbe l'impianto
        sbagliato senza dirlo.
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
        """Cercato per tipo, non per nome: sul pannello si chiama «txtSysPsw»,
        che non contiene la parola «password»."""
        for nome, tipo in self.tipi.items():
            if tipo == "password":
                return nome
        return None


def leggi(html: str) -> Pagina:
    p = Pagina()
    p.feed(html)
    return p


def stato_form(pagina: Pagina) -> dict[str, str]:
    """I campi che ogni postback deve riportare indietro: viewstate e compagnia."""
    return {
        nome: valore for nome, valore in pagina.campi.items()
        if nome.startswith("__") or nome == "monthList"
    }


# Lo <script> in coda alle pagine che arrivano vuote. Vedi la nota in testa.
AUTO_POSTBACK = re.compile(r"__doPostBack\(\s*'__Page'\s*,\s*'PBArg'\s*\)")


class TotemFermo(Exception):
    """Il pannello risponde ma i dati non arrivano.

    Non e' un difetto dello script ne' un cambio del pannello: e' il totem di
    Cannaregio che non risponde a chi glielo chiede. Le pagine servite dalla
    sola applicazione web (login, scelta impianto, tendina dei mesi) continuano
    a funzionare, mentre tutto cio' che deve raggiungere il totem cade in 500 o
    in timeout. Verificato fra il 2026-08-20 e il 2026-08-21.
    """


def manda(sessione: requests.Session, dati: dict[str, str], passo: str) -> str:
    """Un POST solo, con l'errore tradotto in una frase che si capisce."""
    try:
        risposta = sessione.post(BASE_URL, data=dati, timeout=TIMEOUT)
    except requests.Timeout:
        raise TotemFermo(f"{passo}: nessuna risposta entro {TIMEOUT}s")
    except requests.RequestException as errore:
        raise TotemFermo(f"{passo}: {type(errore).__name__}")

    if risposta.status_code >= 500:
        raise TotemFermo(f"{passo}: il pannello ha risposto {risposta.status_code}")

    risposta.raise_for_status()
    return risposta.text


def posta(sessione: requests.Session, dati: dict[str, str],
          seguito: bool = True, passo: str = "postback") -> Pagina:
    """Un postback e il suo seguito.

    Manda i dati, poi finche' la risposta chiede l'auto-postback lo rifa' al
    posto del browser. Il tetto di tre giri esiste solo per non entrare in un
    ciclo infinito se un giorno il pannello lo chiedesse per sempre: al
    2026-08-19 ne basta sempre uno.

    Con seguito=False l'auto-postback si salta: serve dove il seguito riempie
    solo roba che non ci interessa, ed e' il primo passo a cadere quando il
    totem non risponde.
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
# navigazione del pannello
# --------------------------------------------------------------------------

def sveglia_pannello(sessione: requests.Session) -> None:
    """Bussa al pannello finche' non risponde, prima di cominciare sul serio.

    kiosk-vendor.example spegne l'applicazione dopo un periodo di inattivita' e la riavvia
    alla prima richiesta: chi bussa mentre si sta svegliando resta appeso e va
    in timeout. Misurato il 2026-08-19, sei chiamate di fila da freddo:
    timeout a 25s, poi 12,3s, 7,8s, 2,7s, 3,8s, 0,5s.

    Queste chiamate sono buttate via: non serve il risultato, serve che
    l'applicazione riparta mentre nessuno dipende ancora da lei.
    """
    for tentativo in range(1, SVEGLIE + 1):
        try:
            risposta = sessione.get(BASE_URL, timeout=TIMEOUT)
            if risposta.status_code == 200:
                if tentativo > 1:
                    print(f"Pannello sveglio alla chiamata {tentativo}.")
                return
            print(f"Sveglia {tentativo}: il pannello ha risposto {risposta.status_code}.")
        except requests.RequestException as errore:
            print(f"Sveglia {tentativo}: {type(errore).__name__}, era in letargo.")
        time.sleep(PAUSA_SVEGLIA)

    print("Il pannello non ha risposto alle chiamate di sveglia: provo lo stesso.")


def entra(sessione: requests.Session, utente: str, password: str | None, sistema: str) -> Pagina:
    """Login in due schermate.

    1. «User Name» -> campo txtUserName, bottone btnSelecUser.
    2. «System password» -> campo txtSysPsw, piu' TRE bottoni di sistema:
       btnSelectSystem_1 «Luggage Cannaregio cloud»
       btnSelectSystem_2 «Luggage Cannaregio»
       btnSelectSystem_3 «Luggage Cannaregio Dyn»  <- quello in uso
       La password e la scelta del sistema viaggiano nello stesso POST, come
       fa il browser quando si scrive la password e si preme il bottone.
    """
    risposta = sessione.get(BASE_URL, timeout=TIMEOUT)
    risposta.raise_for_status()
    pagina = leggi(risposta.text)

    campo_utente = pagina.campo_di_tipo("user") or pagina.campo_di_tipo("txt")
    bottone = pagina.bottone_con_valore("select") or (pagina.bottoni[0] if pagina.bottoni else None)
    if not campo_utente or not bottone:
        sys.exit("Pagina di login inattesa: non trovo il campo utente o il bottone Select.")

    dati = stato_form(pagina)
    dati[campo_utente] = utente
    dati[bottone[0]] = bottone[1]

    pagina = posta(sessione, dati)

    # Secondo passo: password di sistema e scelta dell'impianto.
    campo_password = pagina.campo_password()
    if campo_password:
        if not password:
            sys.exit(
                "Il pannello chiede la System password ma PROMOTEC_PASSWORD non e' impostata.\n"
                "Mettila nel file .env accanto a questo script."
            )

        bottone = pagina.bottone_con_valore(sistema)
        if not bottone:
            disponibili = [v for _, v in pagina.bottoni if v.lower() != "exit"]
            sys.exit(
                f"Sistema «{sistema}» non trovato nella schermata di scelta.\n"
                f"Quelli disponibili sono: {', '.join(disponibili)}.\n"
                "Correggi PROMOTEC_SISTEMA nel file .env."
            )

        dati = stato_form(pagina)
        dati[campo_password] = password
        dati[bottone[0]] = bottone[1]

        # Senza seguito: l'auto-postback del menu serve solo a disegnare i 56
        # bottoni dei cassetti, che non premiamo mai, e il 21/08/2026 e' il
        # primo passo a cadere quando il totem non risponde. Il bottone
        # «Counters» sta gia' nello scheletro, insieme agli altri quattro
        # comandi. Se un giorno non ci fosse, il seguito si rifa' qui sotto.
        pagina = posta(sessione, dati, seguito=False, passo="scelta impianto")

        if not pagina.bottone_con_valore("counters"):
            campi = stato_form(pagina)
            campi["__EVENTTARGET"] = "__Page"
            campi["__EVENTARGUMENT"] = "PBArg"
            pagina = posta(sessione, campi, seguito=False, passo="menu completo")

    if not pagina.bottone_con_valore("counters"):
        sys.exit(
            "Login non riuscito: dopo l'accesso non trovo il bottone «Counters».\n"
            "Controlla utente, System password e nome del sistema, oppure il\n"
            "pannello e' cambiato."
        )

    return pagina


def apri_counters(sessione: requests.Session, pagina: Pagina) -> Pagina:
    bottone = pagina.bottone_con_valore("counters")
    if not bottone:
        sys.exit("Bottone «Counters» sparito dal menu.")

    dati = stato_form(pagina)
    dati[bottone[0]] = bottone[1]

    return posta(sessione, dati)


def scarica_mese(sessione: requests.Session, pagina: Pagina, mese: str) -> tuple[Pagina, list[list[str]]]:
    """Seleziona un mese e preme «Get Incoming». Torna la pagina nuova, che
    serve per il postback successivo, e le righe lette."""
    bottone = pagina.bottone_con_nome("GetCounterRecords") or pagina.bottone_con_valore("incoming")
    if not bottone:
        sys.exit("Non trovo il bottone «Get Incoming» nella pagina Counters.")

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
# archivio
# --------------------------------------------------------------------------

def carica_archivio(percorso: Path) -> dict[str, list[str]]:
    """L'archivio e' indicizzato per numero di scontrino, che il pannello non
    riusa. Cosi' rileggere un mese due volte non duplica niente."""
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
    print(f"Archivio aggiornato: {len(ordinate)} transazioni in {percorso}")


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
# diagnosi
# --------------------------------------------------------------------------

# Le sole operazioni dell'API che si possono chiamare: leggono e basta. Le
# altre nove aprono cassetti e riavviano l'impianto, senza conferma davanti.
API_CONSENTITE = {"getLockersState", "Proceeds", "History"}


def chiedi_api(env: dict[str, str], operazione: str, extra: dict[str, str] | None = None) -> str:
    """Una chiamata all'API del totem, sul binding HTTP POST.

    In POST e non in GET: cosi' chiave e mastercode restano nel corpo e non
    finiscono nell'URL, dove li registrerebbero i log del server e dei proxy.
    """
    if operazione not in API_CONSENTITE:
        raise ValueError(f"operazione non consentita: {operazione}")

    mancanti = [c for c in ("VENEZIA_API_KEY", "VENEZIA_RECIPIENT", "VENEZIA_MASTERCODE")
                if not env.get(c)]
    if mancanti:
        return f"non provata, mancano nel .env: {', '.join(mancanti)}"

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
    """Le sei prove che dicono dove si rompe, in un colpo solo.

    Serve a rispondere in due minuti alla sola domanda che conta quando
    l'export fallisce: e' il pannello che e' cambiato, oppure il totem non
    risponde? Il 21/08/2026 la risposta e' cambiata due volte in un'ora, e per arrivarci era
    servita mezza sessione.
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
        esiti.append(("login e scelta impianto", f"ok, {len(menu.bottoni)} bottoni"))

        counters = apri_counters(sessione, menu)
        mesi = counters.opzioni.get("monthList", [])
        esiti.append(("pagina Counters", f"ok, mesi {', '.join(mesi) if mesi else 'nessuno'}"))

        if mesi:
            inizio = time.time()
            _, righe = scarica_mese(sessione, counters, mesi[0])
            dati_letti = bool(righe)
            esiti.append((f"scarico di {mesi[0]}",
                          f"{len(righe)} righe in {time.time() - inizio:.0f}s"))
    except TotemFermo as fermo:
        esiti.append(("lettura dei dati", f"FALLITA — {fermo}"))
    except SystemExit as uscita:
        esiti.append(("navigazione", f"FALLITA — {uscita}"))

    esiti.append(("API getLockersState", chiedi_api(env, "getLockersState")))

    print("\nDiagnosi:")
    for passo, esito in esiti:
        print(f"  {passo}: {esito}")

    print("\nVerdetto:")
    if dati_letti:
        print("  Il pannello funziona e i dati arrivano. L'export puo' girare.")
    elif mesi:
        print("  Il pannello risponde e conosce i mesi, ma i record non arrivano.")
        print("  Il pannello non e' cambiato: e' il totem che non risponde a chi")
        print("  gli chiede le transazioni. Stesso sintomo dell'API. Non c'e'")
        print("  niente da correggere nello script: si riprova piu' tardi.")
    else:
        print("  Non si arriva nemmeno alla lista dei mesi. Se il login passa,")
        print("  il blocco e' a valle; se non passa, controlla le credenziali.")


TENTATIVI = 4
PAUSA_TENTATIVI = 90


def con_pazienza(env: dict[str, str], mese: str | None, tentativi: int = TENTATIVI,
                 solo_elenco: bool = False):
    """Rifa' la corsa finche' i dati non arrivano, o finche' i tentativi finiscono.

    Il pannello e' **intermittente**, misurato il 21/08/2026: la stessa
    richiesta ha risposto in 29 secondi e, dieci minuti dopo, non ha risposto
    affatto entro 240. Una corsa sola non dice niente sullo stato del sistema,
    dice solo se si e' stati fortunati.

    Ogni tentativo riparte da una sessione nuova: cookie e viewstate di una
    sessione mezza morta non si riciclano. Quello che e' gia' stato letto resta
    letto, cosi' due tentativi a meta' fanno comunque un mese intero.
    """
    letti: dict[str, list[list[str]]] = {}
    mesi: list[str] = []

    for tentativo in range(1, tentativi + 1):
        if tentativo > 1:
            print(f"\nTentativo {tentativo} di {tentativi}, fra {PAUSA_TENTATIVI}s...")
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
                print("  la tendina dei mesi e' vuota: riprovo.")
                continue

            if solo_elenco:
                return letti, mesi, []

            if mese is not None and mese not in mesi:
                sys.exit(f"Il mese {mese} non e' fra quelli disponibili: {', '.join(mesi)}")

            da_leggere = [m for m in ([mese] if mese else mesi) if m not in letti]
            for m in da_leggere:
                counters, righe = scarica_mese(sessione, counters, m)
                if righe:
                    letti[m] = righe
                    print(f"  {m}: letto, {len(righe)} righe.")
                else:
                    print(f"  {m}: la tabella e' arrivata vuota, riprovo dopo.")

            if all(m in letti for m in ([mese] if mese else mesi)):
                return letti, mesi, []

        except TotemFermo as fermo:
            print(f"  tentativo {tentativo}: {fermo}")

    if not mesi:
        return None

    falliti = [m for m in ([mese] if mese else mesi) if m not in letti]
    if not letti:
        return None
    return letti, mesi, falliti


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="entra e mostra i mesi, senza scrivere")
    parser.add_argument("--diagnosi", action="store_true",
                        help="prova tutta la catena e dice dove si rompe, senza scrivere")
    parser.add_argument("--mese", help="un mese solo, formato MM/AAAA")
    parser.add_argument("--tentativi", type=int, default=TENTATIVI,
                        help=f"quante volte riprovare se il pannello non risponde (default {TENTATIVI})")
    parser.add_argument("--archivio", default=str(Path(__file__).with_name("archivio-incassi.csv")))
    argomenti = parser.parse_args()

    # Utente, password e impianto li legge con_pazienza(), che rifa' la
    # sessione da capo a ogni tentativo.
    env = carica_env()

    if argomenti.diagnosi:
        sessione = requests.Session()
        sessione.headers.update({"User-Agent": UA})
        diagnosi(sessione, env)
        return

    if argomenti.dry_run:
        esito = con_pazienza(env, None, argomenti.tentativi, solo_elenco=True)
        if esito is None:
            raise TotemFermo(f"nessun mese letto in {argomenti.tentativi} tentativi")
        print(f"Mesi disponibili sul pannello: {', '.join(esito[1])}")
        print("  ^ il pannello ne tiene solo tre: quelli piu' vecchi sono gia' persi.")
        return

    percorso = Path(argomenti.archivio)
    archivio = carica_archivio(percorso)
    prima = len(archivio)

    esito = con_pazienza(env, argomenti.mese, argomenti.tentativi)
    if esito is None:
        raise TotemFermo(f"niente dati in {argomenti.tentativi} tentativi")

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
        print(f"  {mese}: {len(righe)} transazioni, {totale:.2f} EUR")

    salva_archivio(percorso, archivio)
    print(f"Nuove rispetto all'archivio: {len(archivio) - prima}")

    if falliti:
        print(
            f"\nATTENZIONE: {', '.join(falliti)} non e' stato letto. Il pannello\n"
            "tiene solo tre mesi: se resta indietro fino a scadere, quei dati\n"
            "spariscono. Rilancia piu' tardi, l'archivio non duplica nulla."
        )


if __name__ == "__main__":
    try:
        main()
    except TotemFermo as fermo:
        sys.exit(
            f"Il pannello non ha dato i dati — {fermo}\n\n"
            "Il pannello e' intermittente: il 21/08/2026 la stessa richiesta ha\n"
            "risposto in 29 secondi e dieci minuti dopo non ha risposto affatto.\n"
            "Se e' fallito anche dopo tutti i tentativi, non c'e' niente da\n"
            "correggere qui: si rilancia piu' tardi, l'archivio non duplica.\n\n"
            "Per vedere dove si rompe:\n"
            "    python export_incassi.py --diagnosi\n"
            "Per insistere di piu':\n"
            "    python export_incassi.py --tentativi 8"
        )
