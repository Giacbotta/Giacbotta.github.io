# Daily Pisa deposits export -> Google Sheet

Downloads every deposit at the Pisa site from the Onniversum management API
and pours it into a Google Sheet, across two tabs:

- **Depositi Pisa**, one row per deposit, the mirror of the panel.
- **Lista invio**, one address per person, not per deposit. Only picked-up
  deposits and only rows with a valid email. Someone who left three bags in
  three lockers shows up once, with the count and the date of the last
  pickup: it is the list the review request starts from.

The sheet is **rewritten in full** on every run: it is always a mirror of the
panel. If the PC is off for a day, the next run recovers on its own, there is
no state to keep aligned and no "lost" days.

> **Watch the `.env`**: it holds the management-system password. This folder
> sits outside OneDrive on purpose, so the credentials do not sync to the
> cloud. Do not move it inside the Vault.

## What does NOT end up on the sheet

`pickupCode` (the code that opens the locker), `apiKey`, `sessionId` and the
pre-authorization codes are excluded on purpose: the sheet can be shared,
those fields cannot. They are in the `CAMPI_ESCLUSI` list in the script.

Every other field passes through, including new ones the vendor might add in
the future, so nothing disappears in silence.

## Installation (once only)

**1. Dependencies**

```bash
python -m pip install -r "C:\path\to\automations\pisa-export\requirements.txt"
```

**2. Management-system credentials**

Copy `.env.example` to `.env` and fill in `PISA_EMAIL` and `PISA_PASSWORD`
with the credentials for `company@example.com`.

**3. Access to the Google Sheet**

You need a *service account*, that is a technical user that writes to the
sheet without going through your own login:

1. Go to <https://console.cloud.google.com/> and create a project (any name, e.g. `nutrie-automazioni`).
2. *APIs & Services -> Library* -> search **Google Sheets API** -> **Enable**.
3. *APIs & Services -> Credentials -> Create Credentials -> Service Account*. Any name, no role needed.
4. Open it -> **Keys** tab -> *Add Key -> Create new key -> JSON*. Download the file.
5. Rename it `service-account.json` and put it in this folder.
6. Open the file: copy the `client_email` value (it ends in `.iam.gserviceaccount.com`).
7. Create the destination Google Sheet, press **Share** and paste that address in as **Editor**.
8. Put the sheet's ID in `SHEET_ID` in the `.env` (it is the long part of the URL, between `/d/` and `/edit`).

## Use

```bash
python "C:\path\to\automations\pisa-export\export_depositi.py" --dry-run
```

Downloads and summarizes without writing anything. This is the command to use for the first try.

```bash
python "C:\path\to\automations\pisa-export\export_depositi.py"
```

Writes to the Google Sheet.

Two more:

- `--schema` prints every field the API returns, useful if the vendor changes something.
- `--csv depositi.csv` writes two CSVs instead of the sheet, `depositi.csv` and
  `depositi-lista-invio.csv`, to test without setting up Google.

> The sheet holds customers' emails and phone numbers. Share it with the
> specific people who need to see it, never with "anyone with the link".

## Daily automatic run

The command below creates the Windows scheduled task that runs the script
every day at 03:30:

```bash
schtasks /Create /TN "Nutrie - Export depositi Pisa" /TR "python \"C:\path\to\automations\pisa-export\export_depositi.py\"" /SC DAILY /ST 03:30 /F
```

The PC has to be on at that time. If it is off, nothing is lost: the next
run realigns the whole sheet.

To check or remove the task:

```bash
schtasks /Query /TN "Nutrie - Export depositi Pisa"
```

```bash
schtasks /Delete /TN "Nutrie - Export depositi Pisa" /F
```

## If it stops working one day

The script talks to `api.locker-vendor.example`, which is the vendor's
**development** environment. If Onniversum moves the service to a production
domain, `BASE_URL` at the top of the script needs to change. It is worth
asking them whether that production domain already exists.

Typical errors:

| Message | Cause |
|---|---|
| `Login rejected` | password changed on the panel |
| `No deposits returned` | the account no longer sees the hub |
| `403` from Google | the sheet is not shared with the service account |
