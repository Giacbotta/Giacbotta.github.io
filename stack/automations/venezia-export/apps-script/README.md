# Venice takings archive with no PC left running (Apps Script)

`Codice.gs` does on Google's servers the same job `export_incassi.py` does on the PC: it logs into the PromoTec panel for Cannaregio, opens Counters, downloads the available months and piles them into a Google Sheet.

## The two-account architecture, and why it is the right one

Decided on 2026-08-19.

| | Account | What lives there |
|---|---|---|
| **Tooling** | `ops@example.com` | The sheet this script writes, and the panel's System password in the Script properties |
| **Management** | `company@example.com` | The real management sheets, which read from the `info@` one via `IMPORTRANGE` |

The point is not organisational, it is security, and it fits in one line: **whoever can edit the sheet can open the script editor and read the password; whoever can only read it, cannot.**

`IMPORTRANGE` works with **read-only** access. So `company@example.com` receives the data without ever being able to reach the credential, and the password never leaves the account that hosts it. That is the reason this separation has to be kept even when it will feel inconvenient.

The practical rule that follows: **the `info@` sheet is never shared with edit rights, with anyone.** If the data has to go to someone, accountant, partner, consultant, you share the `company@example.com` sheet, which holds only numbers.

### The formula to put on the management sheet

The data starts at row 3: row 1 is the summary note, row 2 is the column names.

```
=IMPORTRANGE("ID-O-URL-DEL-FOGLIO-DI-INFO"; "Incassi Venezia!A3:F")
```

If the sheet is in an English locale, the separator is a comma instead of a semicolon. The first time an "Allow access" button appears: you press it once and once only.

To get the header as well, `A2:F`. To know when the panel was last read, `A1`.

## What changes compared to the Python script

The behaviour is the same, what changes is where the data ends up.

| | Python | Apps Script |
|---|---|---|
| Where it runs | Giacomo's PC | Google's servers |
| Where it piles up | `archivio-incassi.csv` | "Incassi Venezia" tab |
| Deduplication key | receipt number | receipt number |
| A single month | `--mese 07/2026` | no, it always downloads all three |
| Dry run | `--dry-run` | no |

The CSV and the sheet have **the same six columns in the same order**, so the two archives stay comparable row by row. They can coexist: they are two independent copies of the same source, and neither one touches the other.

## The rule that must not be broken: the sheet is the archive

The Pisa script rewrites the sheet in full on every run, because the management API keeps the whole history and the sheet is only a mirror.

**Not here.** The Venice panel keeps only three months: what leaves the window is no longer readable anywhere, except in aggregate form in the financial file. So the sheet is not a mirror, it is the archive.

From which: the script **never deletes** rows that are already there. It reads the ones it finds, overwrites them with the months just downloaded, indexing by receipt, and writes back the union sorted by date. A month from two years ago stays there forever.

Practical consequence: **do not delete or reorder rows by hand in the "Incassi Venezia" tab**. The script cannot rebuild what you delete, because the panel no longer has it. If you need a different view, you build it elsewhere, and that is exactly what the management sheet does via `IMPORTRANGE`.

## Installation

Ten minutes, inside `ops@example.com`.

1. **Create the sheet**, empty, in that account's Drive. Call it whatever you like, for example "Incassi Venezia". Do not copy anything into it: the script rebuilds everything from the panel.
2. **Open the editor**: Extensions → Apps Script.
3. **Paste `Codice.gs`** over the content you find already there, and save.
4. **Set the credentials**: Project settings → Script properties → Add property.

   | Property | Value |
   |---|---|
   | `VENEZIA_USER` | the User Name from the panel's first screen |
   | `VENEZIA_PASSWORD` | the System password from the second screen |
   | `VENEZIA_SISTEMA` | optional. Without it, uses `Luggage Cannaregio Dyn` |

   The credentials live here and **not** in the code, so the file can be read and copied without carrying them along.

5. **First run by hand**: go back to the editor, pick `aggiornaIncassi` from the function menu and press Run. The first time, Google asks for authorisation to connect to an external service: it is `panel.kiosk-vendor.example`, grant it.
6. **Check the result**: the "Incassi Venezia" tab has to appear, with the summary note in row 1 and the data from row 3. Compare the total with `archivio-incassi.csv`: as of 2026-08-19 that is 1,023 transactions for 7,202.00 €.
7. **Trigger**: Triggers panel → Add trigger, function `aggiornaIncassi`, time-driven. Once a month is enough; once a day costs nothing and protects you from a missed month.
8. **Connect the management sheet**: from `company@example.com`, `IMPORTRANGE` as above. Share the `info@` sheet with `company@example.com` **read-only**, never with edit rights.

## Use

From the sheet: menu **Nutrie → Update Venice takings**. At the end of the run a notice appears with the per-month summary and how many new rows came in.

From the editor: function `aggiornaIncassi`, and the detail is in the Logs.

Running it twice in a row is safe: the second run adds zero rows. Two simultaneous runs do not tread on each other: the second stops with a message, because the function takes a lock before writing.

## The safety check, and how it is built

The panel is not read-only: next to Counters there are `Unbook All`, `Reboot sysytem`, `Open Ex.Door` and the 56 buttons that open a locker. In the browser those buttons ask for confirmation, but **the confirmation is JavaScript and an HTTP client steps over it**: that protection does not exist here, neither for this script nor for the Python twin.

How it is protected, in order:

1. **By construction.** WebForms decides which button you pressed by looking at which *name* appears in the data sent. The script builds the data from `statoForm()`, which copies only the technical fields (`__VIEWSTATE` and company) plus the month dropdown. A name like `Locker137` has no route in.
2. **By list of what is allowed.** `controllaDati_()` lets through only the technical fields, the text fields declared by the page, and the four buttons in `BOTTONI_CONSENTITI`. Any other button name fails the run, **including a dangerous one the vendor had renamed**, which is the reason it is not a list of prohibitions.
3. **By refusing to guess.** The button lookups are exact-match. If the panel changes, the script stops with a clear error instead of picking the closest-looking button.

## How it works, for whoever will have to touch it

Two non-obvious things, paid for in the field.

**The pages are served in two steps.** The server's first response is a skeleton with no data: the month dropdown comes back empty and the 56 locker buttons are not there. At the bottom of the page there is a `<script>` with `__doPostBack('__Page','PBArg')` that the browser runs straight away, and it is that second postback that fills everything in. Whoever stops at the first response sees an empty page and concludes the panel has changed. `Sessione_.posta()` takes care of it.

**The cookies have to be kept by hand.** `UrlFetchApp` has no session: without sending `ASP.NET_SessionId` back, every postback starts again from the login. `Sessione_.assorbi_()` collects them from the `Set-Cookie` headers.

## If one day it stops working

In order of likelihood.

1. **"The Counters page does not expose the month list"**. The auto-postback is no longer enough. Check whether the final `<script>` at the bottom of the page has changed: the string looked for is `__doPostBack('__Page','PBArg')`.
2. **"The dgIncassi table is not in the response"**. Either the panel has renamed the table, or the session expired mid-run. Run it again: if it works on the second attempt, it was the session.
3. **"I cannot find button X"**. The panel has changed a label or a name. The message lists what it actually found. Do not widen the lookups to partial match to get it going again: that is the shortcut that one day presses the wrong button.
4. **"Refusing to send X to the panel"**. The vendor has renamed one of the four allowed commands. `BOTTONI_CONSENTITI` has to be updated, after looking at what the new button actually does.
5. **"The panel responded 500"**. `kiosk-vendor.example` is small hosting and goes down now and then. It is not a problem with the script.

**How to notice before it does damage**: once a month open the sheet and look at row 1, which says when it was last updated. If that date is more than a month old, you are at risk of losing a month of data forever.

## Checks done before delivery, on 2026-08-19

The `.gs` has not been executed: Apps Script runs only inside Google, and there is no Node on this PC to try it elsewhere. What was verified:

- The regular expressions, the button-choice logic, the safety check and the table-slicing algorithm were reproduced in Python and tried against the real HTML saved from the panel: **23 checks out of 23**. Among them: the 56 locker buttons do not get into the data sent; five dangerous commands are rejected one by one, **including one with a made-up name**, while `BtnCounters` passes; "Luggage Cannaregio" does not pick up "Luggage Cannaregio cloud"; the 462 rows for June come to 3,215.50 €, identical to the CSV.
- The navigation sequence, the auto-postback and the deduplication by receipt are the same as the Python twin, which on 2026-08-19 downloaded 1,023 transactions for 7,202.00 € and added zero on the second run.

**What stays unverified is the Apps Script plumbing**: cookie handling with `UrlFetchApp`, the lock and writing to the sheet are only visible on the first real run. If something breaks, it is almost certainly there.
