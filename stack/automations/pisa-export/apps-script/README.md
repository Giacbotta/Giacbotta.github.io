# Updating the Pisa sheet with no PC left running (Apps Script)

`Codice.gs` does the same job as `export_depositi.py`, but runs **on Google's
servers** instead of Giacomo's PC. Decided on 18/08/2026: it is the path
chosen for B-24, because the PC being on at 03:30 cannot be guaranteed.

The two paths do not coexist. If the service account arrives one day, one of
the two has to be switched off, otherwise they fight over writing the same
sheet.

## Which Google account it lives in

**Workspace account `ops@example.com`**, not `company@example.com`.
Stated by Giacomo on 18/08/2026: Apps Script runs on the Workspace account,
while `company@example.com` is the internal corporate account.

It is not a bureaucratic detail, it is the right call on the merits too: the
review request needs to go out from the address customers already talk to,
and Apps Script sends mail **as the account that runs the script**. Keeping
sheet and script on `info@`, the day the send step gets added there is
nothing to move. On top of that, a Workspace account has much higher sending
quotas than a free account.

The sheet must live **in `info@`'s Drive**. There is no need to copy data
from nutriesrl: the script rebuilds everything from the API on every run, so
it starts from an empty sheet.

> Whoever has access to the `ops@example.com` mailbox can read Script
> Properties, and therefore the management-system password. If that mailbox
> is ever shared with collaborators, the password needs to move to a
> dedicated Workspace user.

## What changes compared to the Python script

| | Python | Apps Script |
|---|---|---|
| Where it runs | Giacomo's PC | Google's servers |
| Needs the PC on | yes | no |
| Needs `service-account.json` | yes | no |
| Where the management-system password lives | `.env` file on disk | the Google project's Script Properties |
| Send-step status columns | lost on every run (E-18) | **preserved** |

The price of the Apps Script path is the last line of the third column: the
management-system password enters the Google account `company@example.com`.
Whoever has access to that account can read it.

## Installation

Everything done **logged in as `ops@example.com`**.

1. On `sheets.new`, create an empty sheet and name it **Depositi Pisa**.
2. *Extensions -> Apps Script*.
3. Delete the contents of `Codice.gs` and paste in the whole `Codice.gs` file
   from this folder. Save.
4. *Project Settings -> Script Properties -> Add script property*:

   | Property | Value |
   |---|---|
   | `PISA_EMAIL` | the email you log into `panel.locker-vendor.example` with |
   | `PISA_PASSWORD` | the password |
   | `PISA_HUB_ID` | optional, only if the account sees more than one kiosk |

5. Back in the editor, pick the `aggiornaDepositi` function and press **Run**.
   Google asks for authorization: it is your own account, accept it.
6. In the editor, **Triggers** panel (the clock icon in the left sidebar) ->
   *Add trigger*: function `aggiornaDepositi`, source *Time-driven*, type
   *Day timer*, time range *3am to 4am*. From that point the sheet rewrites
   itself every night, PC off included.

After the first run, delete the empty "Foglio1" left over from creation by
hand: the script only works on "Depositi Pisa" and "Lista invio".

The two files in `company@example.com`'s Drive, "Depositi Pisa 2026-08-18"
and "Lista invio recensioni Pisa 2026-08-17", are dead snapshots from that
point on. No send status has been lost: as of 18/08/2026 no review request
had gone out yet, so the `inviato`, `dataInvio` and `esito` columns were
empty in both.

## Use

- **Manual update**: menu *Nutrie -> Update now* inside the sheet.
- **Stopping the automation**: editor -> *Triggers* -> delete the trigger.
- **Seeing what happened**: in the editor, *Executions* in the left sidebar.

If a nightly run fails, Google sends an error email to the sheet's owner
address. There is nothing to check by hand.

## The send-step status columns (E-18)

The "Lista invio" tab has three columns the API does not know about and that
belong to the send process: `inviato`, `dataInvio`, `esito`. Before
rewriting, `leggiStato_()` reads them back from the sheet and re-attaches
them **by email address**, lowercased. Anyone already contacted stays marked
that way.

Consequences to be aware of:

- The reconciliation is on the address. If a person has two different
  addresses (`tizio@yahoo.co.uk` and `tizio@gmail.com`), there stay two rows
  with two statuses.
- If an address disappears from the API, a deposit deleted in the management
  system, its row disappears from the sheet and its status is lost. This has
  never happened, but it is how this can break.
- The status columns are written **only** to the sheet. They never travel
  back to the management system.

## If it stops working one day

The script talks to `api.locker-vendor.example`, which is the vendor's
**development** environment. If Onniversum moves the service to a production
domain, `BASE_URL` at the top of the file needs to change.

| Message in Executions | Cause |
|---|---|
| `Login rejected` | password changed on the panel: update the Script Property |
| `No deposits returned` | the account no longer sees the hub |
| `Reading deposits failed, HTTP 5xx` | the vendor's development environment is down |
