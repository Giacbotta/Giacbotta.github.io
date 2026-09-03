# Venezia takings export (PromoTec panel)

`export_incassi.py` reads the **Counters** page of `panel.kiosk-vendor.example` and
accumulates the transactions in `archivio-incassi.csv`.

Source checked on 18/08/2026: **PromoTec, Digital Key Systems** panel,
user `nutrie`, 56 lockers numbered 100-155.

## What it gives and what it does not

One row per transaction, five fields:

| Field | Example | What it is |
|---|---|---|
| `data` | `2026-08-01 09:09:47` | time of payment |
| `importoIvaInclusa` | `4.5` | euro, VAT included |
| `cassetto` | `141` | locker number |
| `scontrino` | `2812` | sequential, never reused: it is the archive key |
| `sconto` | `0` | always 0 in the data read on 18/08/2026 |

There is **no** email, no deposit time, no duration, no locker size and no
sales channel. The row is created at payment. For the Venezia review
requests this source is useless: there is no address.

## The constraint that matters: three months and then it is gone

The panel exposes only **three months** in the `monthList` dropdown. On
18/08/2026 they were 06, 07 and 08/2026: **May and everything before it can no
longer be read**.

That is why the script **accumulates** instead of rewriting, unlike its twin in
Pisa where the API keeps the whole history. `archivio-incassi.csv` is indexed
by receipt number: reading the same month twice duplicates nothing, skipping a
month loses it forever.

**It has to be run at least once a month.** If you skip three months, that data
no longer exists anywhere, except in the accounting file.

## Use

First time: copy `.env.example` to `.env` and fill it in.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py" --dry-run
```

Logs in, prints the available months, writes nothing. This is the first test to run.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py"
```

Downloads every available month and updates the archive.

```bash
python "C:\path\to\automations\venezia-export\export_incassi.py" --mese 07/2026
```

One month only.

```bash
python export_incassi.py --diagnosi
```

Tests the whole chain, panel and API, and says where it breaks. Run it first
when something is wrong: in two minutes it answers the only question that
matters, that is, whether the panel has changed or the data is simply not
coming through.

## The panel is intermittent, and the script keeps trying

Measured between 20 and 21/08/2026: the same request answered in 29 seconds
and, a few minutes later, did not answer at all within 240. In the same hour
HTTP 500 "Runtime Error" appeared after two and a half minutes of waiting.

That is why, since 21/08/2026:

- the timeout is **240 seconds**, no longer 60. Change it with the
  `PROMOTEC_TIMEOUT` environment variable. At 60 the script died in
  `ReadTimeout` before the server answered, and it looked like its own fault;
- the auto-postback that draws the menu of the 56 lockers **is skipped**: it is
  no use here, and it is the first step to fall. The "Counters" button is
  already in the skeleton;
- the run **is repeated** up to 4 times, with a 90 second pause and a fresh
  session each time. Months already read stay read, so two half attempts still
  add up to a whole month. Insist harder with `--tentativi 8`.

If it fails even so, there is nothing to fix: run it again later.
The archive is indexed by receipt and does not duplicate.

**One session at a time.** The kiosk-vendor plan is free and two parallel runs
seem to be enough to bring it down: the 500s on the night between 20 and 21/08
appeared while two sessions were running together. It is not proven, but it is
not worth testing.

## What the script does not do, on purpose

The panel is a **remote control**, not a management system: the same postbacks
that open Counters can open a door in Cannaregio. The script touches only
`Counters` and `Get Incoming`. The `Locker100`-`Locker155`, `BtnUnbookAll`,
`BtnReboot` and `BtnOpenEx` buttons are never pressed, and their names are in
the code only inside the `BOTTONI_PROIBITI` set, as a reminder.

## How it works inside

ASP.NET WebForms: no API, no JSON. Every step is a POST to the same URL that
carries back `__VIEWSTATE`, `__VIEWSTATEGENERATOR` and `__EVENTVALIDATION` read
from the previous page. The path is:

1. `GET /` -> field `txtUserName`, button `btnSelecUser`
2. POST user -> **System password** screen: field `txtSysPsw` and **three**
   system buttons, `btnSelectSystem_1` "Luggage Cannaregio cloud",
   `btnSelectSystem_2` "Luggage Cannaregio", `btnSelectSystem_3` "Luggage
   Cannaregio Dyn". The one in use is the third.
3. POST password + system button -> menu with the 56 lockers
4. POST `BtnCounters` -> Counters page, `monthList` dropdown
5. POST `monthList` + `BtnGetCounterRecords` -> table for the month

Password and system choice travel in the **same** POST, the way the browser
does it when you type the password and press the button.

The system name is compared **in full**, not by substring: "Luggage
Cannaregio" is contained in "Luggage Cannaregio cloud", and a loose comparison
would open the wrong system without saying so.

The field names are not hardcoded: they are found again on every run from the
content of the page. If the vendor renames a button the script still finds it;
if the flow changes, it stops with a clear message instead of pressing
something at random.

## Why Python and not Apps Script

This does not run on Apps Script like the Pisa export. WebForms requires
keeping the session and bouncing the viewstate back at every step:
`UrlFetchApp` does not handle cookies by itself and they would have to be set
by hand on every call. Doable but fragile, and there is no need to run every
night here: one run a month is enough.
