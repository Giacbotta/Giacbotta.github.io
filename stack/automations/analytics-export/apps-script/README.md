# Archivio Simple Analytics dentro il Google Sheet (Apps Script)

`Codice.gs` guarda ogni notte in una cartella di Google Drive, prende i CSV che ci trova, li accumula nel foglio e sposta i file già digeriti in una sottocartella. Il PC può restare spento.

## Chi fa cosa

| Chi | Cosa | Quando |
|---|---|---|
| **Giacomo** | scarica il CSV dalla dashboard e lo lascia cadere nella cartella Drive | ogni due settimane, dieci secondi |
| **Lo script** | legge, accumula senza duplicare, ricalcola gli aggregati, archivia il file | ogni notte, da solo |

## Perché il download resta a mano

L'Export API di Simple Analytics vuole una coppia `sa_api_key_` / `sa_user_id_` che **il piano gratuito non dà: la chiave è a pagamento**. La URL che la dashboard mostra nel browser funziona solo lì, perché si porta dietro il cookie di sessione: chiamata da fuori risponde `503 No permission to access data of example.com`. Verificato il 19/08/2026, e risponde così anche mettendoci una chiave inventata.

Quindi l'unico pezzo che richiede una sessione autenticata resta a mano. Tutto il resto no.

## Perché serve

Il piano gratuito conserva **30 giorni** e poi cancella dai suoi server. Il foglio quindi **non è uno specchio della dashboard: è l'archivio**, ed è l'unico posto dove i dati più vecchi di un mese continuano a esistere. Per questo lo script non cancella mai righe che non stia riscrivendo con dati appena arrivati.

**Il ritmo che conta è questo: mai più di 30 giorni fra un download e l'altro.** Ogni due settimane lascia un margine comodo. Se passano cinque settimane, quella settimana scoperta non esiste più da nessuna parte.

## Cosa scrive

Le schede si creano da sole al primo file.

| Scheda | Cosa tiene |
|---|---|
| `SA Grezzi` | una riga per visita, 20 campi: data, ora, tipo, path, query, referrer, utm, paese, dispositivo, browser, OS, lingua, unicità, sessione, durata, scroll, uuid |
| `SA Totali` | data, pageviews, visitors |
| `SA Pagine` | data, pagina, pageviews, visitors |
| `SA Referrer` | data, referrer, pageviews, visitors |
| `SA UTM` | data, utm_source, pageviews, visitors |
| `SA Log` | quando, comando, file, esito |

`SA Pagine` è quella che conta: è dove le 11 copie di canale in noindex si separano una dall'altra, giorno per giorno. È il numero che il vault non ha mai avuto.

`SA Grezzi` è la rete di sicurezza: le domande che oggi non sappiamo di avere avranno ancora una risposta fra un anno, perché resta il dettaglio e non solo la somma.

**`visitors`** è il conteggio delle righe marcate `is_unique`, che è come Simple Analytics stessa definisce il visitatore: la prima pagina vista in una sessione. Non è una persona seguita nel tempo, e senza cookie non può esserlo.

## Installazione, una volta sola

1. Su Drive, nell'account `ops@example.com`, crea una cartella chiamata **`Simple Analytics export`**.
2. Crea un Google Sheet, per esempio «Analytics Self Luggage Storage».
3. `Estensioni` → `Apps Script`, incolla dentro tutto `Codice.gs`.
4. Metti un primo CSV nella cartella e lancia **`provaPrimoFile`**: non scrive niente e non sposta niente, dice solo quante righe ha letto, quali colonne ha trovato, quali attese mancano e quali giorni copre.
5. Lancia **`importaNuoviCsv`** e guarda il foglio.
6. Lancia **`installaTriggerGiornaliero`**: da lì in poi va da solo, ogni notte fra le 5 e le 6.

Se preferisci un altro nome di cartella, mettilo in `Impostazioni progetto` → `Proprietà script` come `SA_CARTELLA`. Nessuna credenziale, qui: non ne serve nessuna e non va messa nessuna.

## Il download, ogni due settimane

Dalla dashboard di Simple Analytics, l'export CSV. Due accortezze:

- **Fuso `Europe/Rome`**, non UTC. Questi giorni vanno confrontati con l'occupazione dei cassetti, e su UTC le sere d'estate finiscono contate nel giorno dopo.
- **Periodi che si sovrappongono vanno benissimo.** Non serve far combaciare le date con l'ultimo scarico: se un giorno arriva due volte, vince il file caricato per ultimo, che è anche il più assestato. Meglio sovrapporre qualche giorno che rischiare un buco.

I campi possono essere in qualunque ordine e possono mancare: lo script mappa per nome di colonna. L'unico indispensabile è la data (`added_date`, oppure `added_iso` da cui viene ricavata).

## Come si comporta

**Caricare due volte lo stesso file non duplica niente.** Riscrive i giorni contenuti nel file e lascia intatto tutto il resto.

**Un file rotto non blocca gli altri** e non viene archiviato: resta nella cartella, così lo si ritrova, e il motivo finisce in `SA Log`.

**Riscrive solo la coda del foglio**, dalla prima riga con data pari o successiva al giorno più vecchio contenuto nel file. Lo storico vecchio non viene nemmeno riletto: è quello che tiene la corsa corta quando `SA Grezzi` sarà a decine di migliaia di righe.

**Un giorno coperto dal file ma senza traffico viene scritto a zero**, così un giorno vuoto si distingue da un giorno mancante.

## Cosa è stato provato e cosa no

Sulla macchina non c'è un runtime JavaScript, quindi il `.gs` non è stato eseguito. La lettura del CSV, l'accumulo e l'aggregazione sono stati portati in Python riga per riga e messi sotto test in `../test_logica.py`: **19 prove, tutte passate il 19/08/2026**. Coprono le colonne in ordine diverso, le colonne mancanti, le righe senza data, il file vuoto, il doppio caricamento, i periodi sovrapposti, lo storico che resta intatto, gli eventi che non vanno confusi con le pagine, e la somma delle pagine che torna con i totali del giorno.

Non sono provate, e le verifica `provaPrimoFile` con un file vero: la lettura da Drive, il CSV reale di Simple Analytics e la scrittura sul foglio.

Un punto da guardare al primo file: con `type=all` l'export porta sia le pagine viste sia gli eventi, e quale valore della colonna `datapoint` marchi le pagine non è chiarito dalla documentazione. Il codice accetta sia `pageview` sia la casella vuota, così il conteggio non si azzera in silenzio, e `provaPrimoFile` stampa i valori che trova davvero. Se ne salta fuori un terzo, si sistema `eUnaPagina_()`.

## Cosa questo archivio non dirà mai

Simple Analytics non usa cookie e non insegue la persona: dà **conteggi corretti, non percorsi**. Da qui si saprà quanta gente è arrivata su `/googlemaps` o su `/ads` in un certo giorno, e non si saprà chi di quelli ha poi pagato. La cucitura fra chi clicca e chi paga non c'è, ed è una proprietà della fonte, non un limite dello script.
