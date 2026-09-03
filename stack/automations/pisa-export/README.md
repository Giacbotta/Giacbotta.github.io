# Export giornaliero depositi Pisa → Google Sheet

Scarica tutti i depositi della sede di Pisa dall'API del gestionale Onniversum
e li riversa su un Google Sheet, su due schede:

- **Depositi Pisa** — una riga per deposito, lo specchio del pannello.
- **Lista invio** — un indirizzo per persona, non per deposito. Solo depositi
  ritirati e solo righe con email valida. Chi ha lasciato tre bagagli in tre
  cassetti compare una volta sola, con il conteggio e la data dell'ultimo
  ritiro: è la lista da cui parte la richiesta di recensione.

Il foglio viene **riscritto per intero** a ogni esecuzione: è sempre uno specchio
del pannello. Se il PC è spento un giorno, la corsa dopo recupera da sola —
non c'è stato da tenere allineato e non esistono giorni "persi".

> **Attenzione al `.env`**: contiene la password del gestionale. Questa cartella
> sta fuori da OneDrive apposta, così le credenziali non si sincronizzano sul
> cloud. Non spostarla dentro il Vault.

## Cosa NON finisce sul foglio

`pickupCode` (il codice che apre il cassetto), `apiKey`, `sessionId` e i codici
di pre-autorizzazione sono esclusi di proposito: il foglio può essere condiviso,
quei campi no. Sono nella lista `CAMPI_ESCLUSI` dello script.

Tutti gli altri campi passano, compresi quelli nuovi che il fornitore dovesse
aggiungere in futuro — così non spariscono in silenzio.

## Installazione (una volta sola)

**1. Dipendenze**

```bash
python -m pip install -r "C:\path\to\automations\pisa-export\requirements.txt"
```

**2. Credenziali del gestionale**

Copia `.env.example` in `.env` e compila `PISA_EMAIL` e `PISA_PASSWORD` con le
credenziali di `company@example.com`.

**3. Accesso al Google Sheet**

Serve un *service account*, cioè un utente tecnico che scriva sul foglio senza
passare dal tuo login:

1. Vai su <https://console.cloud.google.com/> e crea un progetto (nome libero, es. `nutrie-automazioni`).
2. *API e servizi → Libreria* → cerca **Google Sheets API** → **Abilita**.
3. *API e servizi → Credenziali → Crea credenziali → Account di servizio*. Nome libero, nessun ruolo necessario.
4. Aprilo → scheda **Chiavi** → *Aggiungi chiave → Crea nuova chiave → JSON*. Scarica il file.
5. Rinominalo `service-account.json` e mettilo in questa cartella.
6. Apri il file: copia il valore di `client_email` (finisce per `.iam.gserviceaccount.com`).
7. Crea il Google Sheet di destinazione, premi **Condividi** e incolla quell'indirizzo come **Editor**.
8. Metti l'ID del foglio in `SHEET_ID` nel `.env` (è la parte lunga dell'URL, tra `/d/` e `/edit`).

## Uso

```bash
python "C:\path\to\automations\pisa-export\export_depositi.py" --dry-run
```

Scarica e riepiloga senza scrivere niente. È il comando da usare per la prima prova.

```bash
python "C:\path\to\automations\pisa-export\export_depositi.py"
```

Scrive sul Google Sheet.

Altri due:

- `--schema` stampa tutti i campi che l'API restituisce, utile se il fornitore cambia qualcosa.
- `--csv depositi.csv` scrive due CSV invece del foglio — `depositi.csv` e
  `depositi-lista-invio.csv` — per provare senza configurare Google.

> Il foglio contiene email e telefoni dei clienti. Va condiviso con le singole
> persone che devono vederlo, mai con «chiunque abbia il link».

## Esecuzione automatica ogni giorno

Il comando qui sotto crea l'attività pianificata di Windows che lancia lo script
ogni giorno alle 03:30:

```bash
schtasks /Create /TN "Nutrie - Export depositi Pisa" /TR "python \"C:\path\to\automations\pisa-export\export_depositi.py\"" /SC DAILY /ST 03:30 /F
```

Il PC deve essere acceso a quell'ora. Se è spento, non si perde nulla: la corsa
successiva riallinea tutto il foglio.

Per controllare o togliere l'attività:

```bash
schtasks /Query /TN "Nutrie - Export depositi Pisa"
```

```bash
schtasks /Delete /TN "Nutrie - Export depositi Pisa" /F
```

## Se un giorno smette di funzionare

Lo script parla con `api.locker-vendor.example`, che è l'**ambiente di
sviluppo** del fornitore. Se Onniversum sposta il servizio su un dominio di
produzione, va cambiato `BASE_URL` in cima allo script. Vale la pena chiedergli
se quel dominio di produzione esiste già.

Errori tipici:

| Messaggio | Causa |
|---|---|
| `Login rifiutato` | password cambiata sul pannello |
| `Nessun deposito restituito` | l'account non vede più l'hub |
| `403` da Google | il foglio non è condiviso col service account |
