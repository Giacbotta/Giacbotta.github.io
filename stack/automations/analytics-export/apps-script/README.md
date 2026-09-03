# Simple Analytics archive inside the Google Sheet (Apps Script)

`Codice.gs` looks every night in a Google Drive folder, takes the CSVs it finds there, piles them up in the sheet and moves the files it has already digested into a subfolder. The PC can stay off.

## Who does what

| Who | What | When |
|---|---|---|
| **Giacomo** | downloads the CSV from the dashboard and drops it into the Drive folder | every two weeks, ten seconds |
| **The script** | reads, piles up without duplicating, recomputes the aggregates, archives the file | every night, on its own |

## Why the download stays manual

The Simple Analytics Export API wants an `sa_api_key_` / `sa_user_id_` pair that **the free plan does not give: the key is paid for**. The URL the dashboard shows in the browser works only there, because it carries the session cookie with it: called from outside it answers `503 No permission to access data of example.com`. Checked on 19 August 2026, and it answers the same way with a made-up key too.

So the only piece that needs an authenticated session stays manual. Everything else does not.

## Why it is needed

The free plan keeps **30 days** and then deletes from its servers. The sheet therefore **is not a mirror of the dashboard: it is the archive**, and it is the only place where data older than a month keeps on existing. That is why the script never deletes rows it is not rewriting with data that has just arrived.

**The rhythm that matters is this one: never more than 30 days between one download and the next.** Every two weeks leaves a comfortable margin. If five weeks go by, that uncovered week does not exist anywhere any more.

## What it writes

The sheets create themselves with the first file.

| Sheet | What it holds |
|---|---|
| `SA Grezzi` | one row per visit, 20 fields: date, time, type, path, query, referrer, utm, country, device, browser, OS, language, uniqueness, session, duration, scroll, uuid |
| `SA Totali` | date, pageviews, visitors |
| `SA Pagine` | date, page, pageviews, visitors |
| `SA Referrer` | date, referrer, pageviews, visitors |
| `SA UTM` | date, utm_source, pageviews, visitors |
| `SA Log` | when, command, file, outcome |

`SA Pagine` is the one that counts: it is where the 11 noindex channel copies come apart from one another, day by day. It is the number the vault never had.

`SA Grezzi` is the safety net: the questions we do not know we have today will still have an answer in a year, because the detail stays and not only the sum.

**`visitors`** is the count of the rows marked `is_unique`, which is how Simple Analytics itself defines a visitor: the first page seen in a session. It is not a person followed over time, and without cookies it cannot be.

## Installation, once only

1. On Drive, in the `ops@example.com` account, create a folder called **`Simple Analytics export`**.
2. Create a Google Sheet, for example "Analytics Self Luggage Storage".
3. `Extensions` → `Apps Script`, paste all of `Codice.gs` in there.
4. Put a first CSV in the folder and run **`provaPrimoFile`**: it writes nothing and moves nothing, it only says how many rows it read, which columns it found, which expected ones are missing and which days it covers.
5. Run **`importaNuoviCsv`** and look at the sheet.
6. Run **`installaTriggerGiornaliero`**: from there on it goes on its own, every night between 5 and 6.

If you prefer another folder name, put it in `Project Settings` → `Script Properties` as `SA_CARTELLA`. No credentials here: none are needed and none should be put in.

## The download, every two weeks

From the Simple Analytics dashboard, the CSV export. Two things to watch:

- **Timezone `Europe/Rome`**, not UTC. These days have to be compared with how full the lockers are, and on UTC the summer evenings end up counted in the next day.
- **Overlapping periods are perfectly fine.** There is no need to line the dates up with the last download: if a day arrives twice, the file loaded last wins, and it is also the most settled one. Better to overlap a few days than to risk a hole.

The fields can be in any order and can be missing: the script maps by column name. The only indispensable one is the date (`added_date`, or `added_iso` from which it is derived).

## How it behaves

**Loading the same file twice duplicates nothing.** It rewrites the days contained in the file and leaves everything else untouched.

**A broken file does not block the others** and does not get archived: it stays in the folder, so it can be found again, and the reason ends up in `SA Log`.

**It rewrites only the tail of the sheet**, from the first row with a date equal to or later than the oldest day contained in the file. The old history is not even read again: that is what keeps the run short once `SA Grezzi` is at tens of thousands of rows.

**A day covered by the file but with no traffic gets written as zero**, so an empty day can be told from a missing one.

## What has been tested and what has not

There is no JavaScript runtime on the machine, so the `.gs` has not been run. Reading the CSV, piling up and aggregating have been carried over to Python line by line and put under test in `../test_logica.py`: **19 checks, all passed on 19 August 2026**. They cover the columns in a different order, the missing columns, the rows without a date, the empty file, the double load, the overlapping periods, the history staying untouched, the events that must not be confused with pages, and the sum of the pages matching the totals of the day.

Not tested, and what checks them is `provaPrimoFile` with a real file: reading from Drive, the real Simple Analytics CSV and writing to the sheet.

One point to look at with the first file: with `type=all` the export brings both the pageviews and the events, and which value of the `datapoint` column marks the pages is not made clear by the documentation. The code accepts both `pageview` and the empty cell, so the count does not go to zero in silence, and `provaPrimoFile` prints the values it actually finds. If a third one turns up, `eUnaPagina_()` gets fixed.

## What this archive will never say

Simple Analytics uses no cookies and does not chase the person: it gives **correct counts, not paths**. From here we will know how many people landed on `/googlemaps` or on `/ads` on a given day, and we will not know which of them then paid. The stitch between who clicks and who pays is not there, and it is a property of the source, not a limit of the script.
