# Aggiornamento del foglio Pisa senza PC acceso (Apps Script)

`Codice.gs` fa lo stesso lavoro di `export_depositi.py`, ma gira **sui server di
Google** invece che sul PC di Giacomo. Deciso il 18/08/2026: e' la strada scelta
per B-24, perche' non si puo' garantire il PC acceso alle 03:30.

Le due strade non convivono. Se un giorno arriva il service account, va spento
uno dei due, altrimenti si contendono la scrittura dello stesso foglio.

## In quale account Google vive

**Account Workspace `ops@example.com`**, non `company@example.com`.
Dichiarato da Giacomo il 18/08/2026: gli Apps Script girano sull'account
Workspace, mentre `company@example.com` e' l'account interno societario.

Non e' un dettaglio burocratico, e' la scelta giusta anche nel merito: la
richiesta di recensione va spedita dall'indirizzo con cui si parla ai clienti,
e Apps Script manda le mail **come l'account che esegue lo script**. Tenendo
foglio e script su `info@`, il giorno in cui si aggiunge l'invio non c'e'
niente da spostare. In piu' un account Workspace ha quote di invio molto piu'
alte di un account gratuito.

Il foglio deve stare **nel Drive di `info@`**. Non serve copiare dati da
nutriesrl: lo script ricostruisce tutto dall'API a ogni corsa, quindi si parte
da un foglio vuoto.

> Chi ha accesso alla casella `ops@example.com` puo' leggere le
> Proprieta' script, e quindi la password del gestionale. Se un domani quella
> casella viene condivisa con collaboratori, la password va spostata su un
> utente Workspace dedicato.

## Cosa cambia rispetto allo script Python

| | Python | Apps Script |
|---|---|---|
| Dove gira | PC di Giacomo | server Google |
| Serve il PC acceso | si' | no |
| Serve `service-account.json` | si' | no |
| Dove sta la password del gestionale | file `.env` sul disco | Proprieta' script del progetto Google |
| Colonne di stato dell'invio | si perdono a ogni corsa (E-18) | **preservate** |

Il prezzo della strada Apps Script e' l'ultima riga della terza colonna: la
password del gestionale entra nell'account Google `company@example.com`. Chi ha
accesso a quell'account puo' leggerla.

## Installazione

Tutto da fare **loggato come `ops@example.com`**.

1. Su `sheets.new`, crea un foglio vuoto e chiamalo **Depositi Pisa**.
2. *Estensioni -> Apps Script*.
3. Cancella il contenuto di `Codice.gs` e incolla tutto il file `Codice.gs` di
   questa cartella. Salva.
4. *Impostazioni progetto -> Proprieta' script -> Aggiungi proprieta' script*:

   | Proprieta' | Valore |
   |---|---|
   | `PISA_EMAIL` | l'email con cui entri su `panel.locker-vendor.example` |
   | `PISA_PASSWORD` | la password |
   | `PISA_HUB_ID` | facoltativa, solo se l'account vede piu' di un chiosco |

5. Torna all'editor, scegli la funzione `aggiornaDepositi` e premi **Esegui**.
   Google chiede l'autorizzazione: e' il tuo stesso account, si accetta.
6. Nell'editor, pannello **Attivatori** (l'icona a sveglia nella barra a
   sinistra) -> *Aggiungi attivatore*: funzione `aggiornaDepositi`, origine
   *Basato sul tempo*, tipo *Timer giornaliero*, fascia oraria *03:00-04:00*.
   Da quel momento il foglio si riscrive ogni notte, PC spento compreso.

Dopo la prima corsa, elimina a mano il «Foglio1» vuoto rimasto dalla creazione:
lo script lavora solo su «Depositi Pisa» e «Lista invio».

I due file nel Drive di `company@example.com` — «Depositi Pisa 2026-08-18» e
«Lista invio recensioni Pisa 2026-08-17» — a quel punto sono fotografie morte.
Nessuno stato d'invio e' andato perso: al 18/08/2026 non era ancora partita
nessuna richiesta di recensione, quindi le colonne `inviato`, `dataInvio` ed
`esito` erano vuote in entrambi.

## Uso

- **Aggiornamento a mano**: menu *Nutrie -> Aggiorna adesso* dentro il foglio.
- **Fermare l'automatismo**: editor -> *Attivatori* -> elimina l'attivatore.
- **Vedere cosa e' successo**: nell'editor, *Esecuzioni* nella barra a sinistra.

Se una corsa notturna fallisce, Google manda una mail di errore all'indirizzo
proprietario del foglio. Non serve controllare nulla a mano.

## Le colonne di stato dell'invio (E-18)

La scheda «Lista invio» ha tre colonne che l'API non conosce e che appartengono
al processo di invio: `inviato`, `dataInvio`, `esito`. Prima di riscrivere,
`leggiStato_()` le rilegge dal foglio e le riaggancia **per indirizzo email**,
in minuscolo. Chi e' gia' stato contattato resta segnato tale.

Conseguenze da conoscere:

- La riconciliazione e' sull'indirizzo. Se una persona ha due indirizzi diversi
  (`tizio@yahoo.co.uk` e `tizio@gmail.com`), restano due righe con due stati.
- Se un indirizzo sparisce dall'API — deposito cancellato a gestionale — la sua
  riga sparisce dal foglio e il suo stato si perde. Non e' mai successo, ma e'
  il modo in cui questo puo' rompersi.
- Le colonne di stato si scrivono **solo** nel foglio. Non tornano indietro
  verso il gestionale.

## Se un giorno smette di funzionare

Lo script parla con `api.locker-vendor.example`, che e' l'ambiente di
**sviluppo** del fornitore. Se Onniversum sposta il servizio su un dominio di
produzione, va cambiato `BASE_URL` in cima al file.

| Messaggio nelle Esecuzioni | Causa |
|---|---|
| `Login rifiutato` | password cambiata sul pannello: aggiorna la Proprieta' script |
| `Nessun deposito restituito` | l'account non vede piu' l'hub |
| `Lettura depositi fallita, HTTP 5xx` | l'ambiente di sviluppo del fornitore e' giu' |
