# Archivio degli incassi di Venezia senza PC acceso (Apps Script)

`Codice.gs` fa sui server di Google lo stesso lavoro che `export_incassi.py` fa sul PC: entra nel pannello PromoTec di Cannaregio, apre Counters, scarica i mesi disponibili e li accumula in un Google Sheet.

## L'architettura a due account, e perché è quella giusta

Decisa il 2026-08-19.

| | Account | Cosa ci sta |
|---|---|---|
| **Strumento** | `ops@example.com` | Il foglio che questo script scrive, e la System password del pannello nelle Proprietà script |
| **Gestione** | `company@example.com` | I fogli gestionali veri, che leggono da quello di `info@` via `IMPORTRANGE` |

Il punto non è organizzativo, è di sicurezza, e sta tutto in una riga: **chi può modificare il foglio può aprire l'editor dello script e leggere la password; chi può solo leggerlo, no.**

`IMPORTRANGE` funziona con l'accesso in **sola lettura**. Quindi `company@example.com` riceve i dati senza mai poter arrivare alla credenziale, e la password non esce dall'account che la ospita. È la ragione per cui questa separazione va mantenuta anche quando sembrerà scomoda.

Regola pratica che ne discende: **il foglio di `info@` non si condivide mai in modifica con nessuno.** Se serve dare i dati a qualcuno — commercialista, socio, consulente — si condivide il foglio di `company@example.com`, che contiene solo numeri.

### La formula da mettere sul foglio di gestione

I dati partono dalla riga 3: la riga 1 è la nota di riepilogo, la riga 2 sono i nomi delle colonne.

```
=IMPORTRANGE("ID-O-URL-DEL-FOGLIO-DI-INFO"; "Incassi Venezia!A3:F")
```

Se il foglio è in locale inglese, il separatore è la virgola invece del punto e virgola. La prima volta compare un pulsante «Consenti accesso»: si preme una volta sola.

Per avere anche l'intestazione, `A2:F`. Per sapere quando il pannello è stato letto l'ultima volta, `A1`.

## Cosa cambia rispetto allo script Python

Il comportamento è lo stesso, cambia dove finiscono i dati.

| | Python | Apps Script |
|---|---|---|
| Dove gira | PC di Giacomo | server di Google |
| Dove accumula | `archivio-incassi.csv` | scheda «Incassi Venezia» |
| Chiave di deduplica | numero di scontrino | numero di scontrino |
| Un mese solo | `--mese 07/2026` | no, scarica sempre i tre |
| Prova a vuoto | `--dry-run` | no |

Il CSV e il foglio hanno **le stesse sei colonne nello stesso ordine**, così i due archivi restano confrontabili riga per riga. Possono convivere: sono due copie indipendenti della stessa fonte, e nessuna delle due tocca l'altra.

## La regola che non va rotta: il foglio è l'archivio

Lo script di Pisa riscrive il foglio per intero a ogni corsa, perché l'API del gestionale conserva tutto lo storico e il foglio è solo uno specchio.

**Qui no.** Il pannello di Venezia tiene solo tre mesi: quello che esce dalla finestra non è più leggibile da nessuna parte, se non in forma aggregata nel file finanziario. Quindi il foglio non è uno specchio, è l'archivio.

Da cui: lo script **non cancella mai** righe già presenti. Legge quelle che ci sono, ci sovrascrive i mesi appena scaricati indicizzando per scontrino, e riscrive l'unione ordinata per data. Un mese di due anni fa resta lì per sempre.

Conseguenza pratica: **non cancellare né riordinare righe a mano nella scheda «Incassi Venezia»**. Lo script non può ricostruire quello che cancelli, perché il pannello non ce l'ha più. Se serve una vista diversa, si costruisce altrove, ed è esattamente quello che fa il foglio di gestione via `IMPORTRANGE`.

## Installazione

Dieci minuti, dentro `ops@example.com`.

1. **Crea il foglio**, vuoto, in Drive di quell'account. Chiamalo come vuoi, per esempio «Incassi Venezia». Non copiarci dentro niente: lo script ricostruisce tutto dal pannello.
2. **Apri l'editor**: Estensioni → Apps Script.
3. **Incolla `Codice.gs`** al posto del contenuto che trovi già lì, e salva.
4. **Metti le credenziali**: Impostazioni progetto → Proprietà script → Aggiungi proprietà.

   | Proprietà | Valore |
   |---|---|
   | `VENEZIA_USER` | lo User Name della prima schermata del pannello |
   | `VENEZIA_PASSWORD` | la System password della seconda schermata |
   | `VENEZIA_SISTEMA` | facoltativa. Senza, usa `Luggage Cannaregio Dyn` |

   Le credenziali stanno qui e **non** nel codice, così il file si può leggere e copiare senza portarsele dietro.

5. **Prima corsa a mano**: torna sull'editor, scegli `aggiornaIncassi` nel menu delle funzioni e premi Esegui. La prima volta Google chiede l'autorizzazione a connettersi a un servizio esterno: è `panel.kiosk-vendor.example`, va concessa.
6. **Controlla il risultato**: la scheda «Incassi Venezia» deve comparire, con in riga 1 la nota di riepilogo e i dati dalla riga 3. Confronta il totale con `archivio-incassi.csv`: al 2026-08-19 sono 1.023 transazioni per 7.202,00 €.
7. **Attivatore**: pannello Attivatori → Aggiungi attivatore, funzione `aggiornaIncassi`, su base temporale. Una volta al mese basta; una volta al giorno costa nulla e mette al riparo da un mese saltato.
8. **Collega il foglio di gestione**: da `company@example.com`, `IMPORTRANGE` come sopra. Condividi il foglio di `info@` con `company@example.com` **in sola lettura**, mai in modifica.

## Uso

Dal foglio: menu **Nutrie → Aggiorna incassi Venezia**. A fine corsa compare un avviso con il riepilogo per mese e quante righe nuove sono entrate.

Dall'editor: funzione `aggiornaIncassi`, e il dettaglio sta nei Log.

Rilanciarlo due volte di fila è sicuro: la seconda corsa aggiunge zero righe. Due corse contemporanee non si pestano i piedi: la seconda si ferma con un messaggio, perché la funzione prende un lucchetto prima di scrivere.

## Il controllo di sicurezza, e come è fatto

Il pannello non è di sola lettura: accanto a Counters ci sono `Unbook All`, `Reboot sysytem`, `Open Ex.Door` e i 56 bottoni che aprono un cassetto. Nel browser quei bottoni chiedono conferma, ma **la conferma è JavaScript e un client HTTP la scavalca**: quella protezione qui non esiste, né per questo script né per il gemello Python.

Come è protetto, in ordine:

1. **Per costruzione.** WebForms decide quale bottone hai premuto guardando quale *nome* compare nei dati inviati. Lo script costruisce i dati da `statoForm()`, che copia solo i campi tecnici (`__VIEWSTATE` e compagnia) più la tendina dei mesi. Un nome come `Locker137` non ha nessun percorso per entrarci.
2. **Per lista di ciò che è consentito.** `controllaDati_()` lascia passare solo i campi tecnici, i campi di testo dichiarati dalla pagina, e i quattro bottoni di `BOTTONI_CONSENTITI`. Qualunque altro nome di bottone fa fallire la corsa — **anche uno pericoloso che il fornitore avesse rinominato**, che è il motivo per cui non è una lista di divieti.
3. **Per rifiuto di indovinare.** Le ricerche dei bottoni sono a corrispondenza esatta. Se il pannello cambia, lo script si ferma con un errore chiaro invece di scegliere il bottone più somigliante.

## Come funziona, per chi dovrà metterci le mani

Due cose non ovvie, pagate sul campo.

**Le pagine si servono in due tempi.** La prima risposta del server è uno scheletro senza dati: la tendina dei mesi arriva vuota e i 56 bottoni dei cassetti non ci sono. In fondo alla pagina c'è uno `<script>` con `__doPostBack('__Page','PBArg')` che il browser esegue subito, ed è quel secondo postback a riempire tutto. Chi si ferma alla prima risposta vede una pagina vuota e conclude che il pannello sia cambiato. Ci pensa `Sessione_.posta()`.

**I cookie vanno tenuti a mano.** `UrlFetchApp` non ha una sessione: senza rimandare indietro `ASP.NET_SessionId` ogni postback ricomincia dal login. Li raccoglie `Sessione_.assorbi_()` dalle intestazioni `Set-Cookie`.

## Se un giorno smette di funzionare

In ordine di probabilità.

1. **«La pagina Counters non espone la lista dei mesi»** — l'auto-postback non basta più. Guarda se in fondo alla pagina lo `<script>` finale è cambiato: la stringa cercata è `__doPostBack('__Page','PBArg')`.
2. **«La tabella dgIncassi non c'è nella risposta»** — o il pannello ha rinominato la tabella, o la sessione è scaduta a metà corsa. Rilancia: se al secondo tentativo va, era la sessione.
3. **«Non trovo il bottone X»** — il pannello ha cambiato un'etichetta o un nome. Il messaggio elenca quello che ha trovato davvero. Non allargare le ricerche a corrispondenza parziale per farlo ripartire: è la scorciatoia che un giorno preme il bottone sbagliato.
4. **«Rifiuto di mandare X al pannello»** — il fornitore ha rinominato uno dei quattro comandi consentiti. Va aggiornata `BOTTONI_CONSENTITI`, dopo aver guardato cosa fa davvero il bottone nuovo.
5. **«Il pannello ha risposto 500»** — `kiosk-vendor.example` è un hosting piccolo e ogni tanto cade. Non è un problema dello script.

**Il modo di accorgersene prima che faccia danno**: una volta al mese apri il foglio e guarda la riga 1, che dice quando è stato aggiornato l'ultima volta. Se quella data è vecchia di più di un mese, sei a rischio di perdere un mese di dati per sempre.

## Verifiche fatte prima della consegna, il 2026-08-19

Il `.gs` non è stato eseguito: Apps Script gira solo dentro Google, e su questo PC non c'è Node per provarlo altrove. Quello che è stato verificato:

- Le espressioni regolari, la logica di scelta dei bottoni, il controllo di sicurezza e l'algoritmo di ritaglio della tabella sono stati riprodotti in Python e provati contro l'HTML vero salvato dal pannello: **23 verifiche su 23**. Fra queste: i 56 bottoni cassetto non entrano nei dati inviati; cinque comandi pericolosi vengono respinti uno per uno, **incluso uno con un nome inventato**, mentre `BtnCounters` passa; «Luggage Cannaregio» non pesca «Luggage Cannaregio cloud»; le 462 righe di giugno danno 3.215,50 €, identico al CSV.
- La sequenza di navigazione, l'auto-postback e la deduplica per scontrino sono gli stessi del gemello Python, che il 2026-08-19 ha scaricato 1.023 transazioni per 7.202,00 € e alla seconda corsa ne ha aggiunte zero.

**Resta non verificata l'idraulica di Apps Script**: la gestione dei cookie con `UrlFetchApp`, il lucchetto e la scrittura sul foglio si vedono solo alla prima corsa vera. Se qualcosa si rompe, è quasi certamente lì.
