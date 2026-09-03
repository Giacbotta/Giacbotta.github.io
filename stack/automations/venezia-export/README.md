# Export degli incassi di Venezia (pannello PromoTec)

`export_incassi.py` legge la pagina **Counters** di `panel.kiosk-vendor.example` e
accumula le transazioni in `archivio-incassi.csv`.

Sorgente verificata il 18/08/2026: pannello **PromoTec — Digital Key Systems**,
utente `nutrie`, 56 cassetti numerati 100-155.

## Cosa da' e cosa non da'

Una riga per transazione, cinque campi:

| Campo | Esempio | Cosa e' |
|---|---|---|
| `data` | `2026-08-01 09:09:47` | momento del pagamento |
| `importoIvaInclusa` | `4.5` | euro, IVA inclusa |
| `cassetto` | `141` | numero del locker |
| `scontrino` | `2812` | progressivo, non riusato: e' la chiave dell'archivio |
| `sconto` | `0` | sempre 0 nei dati letti al 18/08/2026 |

**Non** ci sono email, ne' orario di deposito, ne' durata, ne' taglia del
cassetto, ne' canale di vendita. La riga nasce al pagamento. Per le richieste
di recensione di Venezia questa fonte non serve: non c'e' un indirizzo.

## Il vincolo che conta: tre mesi e poi sparisce

Il pannello espone solo **tre mesi** nella tendina `monthList`. Al 18/08/2026
erano 06, 07 e 08/2026: **maggio e i mesi precedenti non sono piu' leggibili**.

Per questo lo script **accumula** invece di riscrivere, al contrario del gemello
di Pisa dove l'API tiene tutto lo storico. `archivio-incassi.csv` e' indicizzato
per numero di scontrino: rileggere lo stesso mese due volte non duplica nulla,
saltare un mese lo perde per sempre.

**Va lanciato almeno una volta al mese.** Se salti tre mesi, quei dati non
esistono piu' da nessuna parte, se non nel file finanziario.

## Uso

Prima volta: copia `.env.example` in `.env` e compilalo.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py" --dry-run
```

Entra, stampa i mesi disponibili, non scrive niente. E' la prova da fare per prima.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py"
```

Scarica tutti i mesi disponibili e aggiorna l'archivio.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py" --mese 07/2026
```

Un mese solo.

```bash
python export_incassi.py --diagnosi
```

Prova tutta la catena, pannello e API, e dice dove si rompe. Da lanciare per
primo quando qualcosa non va: risponde in due minuti alla sola domanda che
conta, cioe' se il pannello e' cambiato oppure se i dati semplicemente non
stanno arrivando.

## Il pannello e' intermittente, e lo script insiste

Misurato fra il 20 e il 21/08/2026: la stessa richiesta ha risposto in 29
secondi e, pochi minuti dopo, non ha risposto affatto entro 240. Nella stessa ora sono comparsi
HTTP 500 «Runtime Error» dopo due minuti e mezzo di attesa.

Per questo, dal 21/08/2026:

- il timeout e' **240 secondi**, non piu' 60. Si cambia con la variabile
  d'ambiente `PROMOTEC_TIMEOUT`. Con 60 lo script moriva in `ReadTimeout`
  prima che il server rispondesse, e sembrava un difetto suo;
- l'auto-postback che disegna il menu dei 56 cassetti **si salta**: non serve a
  niente qui, ed e' il primo passo a cadere. Il bottone «Counters» sta gia'
  nello scheletro;
- la corsa **si ripete** fino a 4 volte, con 90 secondi di pausa e una sessione
  nuova ogni volta. I mesi gia' letti restano letti, quindi due tentativi a
  meta' fanno comunque un mese intero. Si insiste di piu' con `--tentativi 8`.

Se fallisce anche cosi', non c'e' niente da correggere: si rilancia piu' tardi.
L'archivio e' indicizzato per scontrino e non duplica.

**Una sessione alla volta.** Il piano kiosk-vendor e' gratuito e due corse in parallelo
sembrano bastare a farlo cadere: i 500 della notte fra il 20 e il 21/08 sono comparsi mentre giravano
due sessioni insieme. Non e' dimostrato, ma non conviene provarlo.

## Cosa lo script non fa, di proposito

Il pannello e' un **telecomando**, non un gestionale: gli stessi postback che
aprono Counters possono aprire uno sportello a Cannaregio. Lo script tocca
solo `Counters` e `Get Incoming`. I bottoni `Locker100`-`Locker155`,
`BtnUnbookAll`, `BtnReboot` e `BtnOpenEx` non vengono mai premuti, e i loro
nomi stanno nel codice solo dentro l'insieme `BOTTONI_PROIBITI`, per memoria.

## Come e' fatto dentro

ASP.NET WebForms: niente API, niente JSON. Ogni passo e' un POST alla stessa
URL che si riporta dietro `__VIEWSTATE`, `__VIEWSTATEGENERATOR` e
`__EVENTVALIDATION` letti dalla pagina precedente. Il percorso e':

1. `GET /` -> campo `txtUserName`, bottone `btnSelecUser`
2. POST utente -> schermata **System password**: campo `txtSysPsw` e **tre**
   bottoni di impianto, `btnSelectSystem_1` «Luggage Cannaregio cloud»,
   `btnSelectSystem_2` «Luggage Cannaregio», `btnSelectSystem_3` «Luggage
   Cannaregio Dyn». Quello in uso e' il terzo.
3. POST password + bottone dell'impianto -> menu con i 56 cassetti
4. POST `BtnCounters` -> pagina Counters, tendina `monthList`
5. POST `monthList` + `BtnGetCounterRecords` -> tabella del mese

Password e scelta dell'impianto viaggiano nello **stesso** POST, come fa il
browser quando si scrive la password e si preme il bottone.

Il nome dell'impianto si confronta **per intero**, non per contenuto: «Luggage
Cannaregio» e' contenuto dentro «Luggage Cannaregio cloud», e un confronto
approssimativo aprirebbe l'impianto sbagliato senza dirlo.

I nomi dei campi non sono scritti a mano nel codice: vengono ritrovati a ogni
corsa dal contenuto della pagina. Se il fornitore rinomina un bottone lo script
lo ritrova lo stesso; se cambia il flusso, si ferma con un messaggio chiaro
invece di premere qualcosa a caso.

## Perche' Python e non Apps Script

Questo non gira su Apps Script come l'export di Pisa. WebForms richiede di
tenere la sessione e di rimbalzare il viewstate a ogni passo: `UrlFetchApp` non
gestisce i cookie da solo e andrebbero rimessi a mano a ogni chiamata. Fattibile
ma fragile, e qui non serve girare ogni notte: una corsa al mese basta.
