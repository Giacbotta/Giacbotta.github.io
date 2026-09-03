# automations

Four jobs. None of them runs on a server I pay for: three live in Google Apps
Script, one runs on a laptop when I ask it to.

| Folder | What it does | Where it runs |
| --- | --- | --- |
| [`venezia-export/`](venezia-export/) | Reads the takings page of the Venice kiosk back office and writes them into a Sheet. Python version and Apps Script version of the same job. | Apps Script, nightly |
| [`pisa-export/`](pisa-export/) | Pulls every deposit from the Pisa management API into a Sheet, plus the mailing list extract. | Apps Script, nightly |
| [`analytics-export/`](analytics-export/) | Archives Simple Analytics CSVs into a Sheet, because the free plan deletes data after 30 days. | Apps Script, nightly |
| [`gmail-feedback/`](gmail-feedback/) | Turns receipt emails into Google review requests, once per customer. | Apps Script, on a trigger |

## Two accounts, on purpose

The Sheets that hold a credential live in one Google account. The Sheets people
actually read live in another, and pull the numbers across with `IMPORTRANGE`,
which only needs read access. So the account that gets shared with an
accountant or a partner can never reach the credential. It looks like
bureaucracy until the day someone asks for access to a sheet.

## Secrets

No credential is in this repo, and none is in the code. The Python jobs read a
`.env` next to the script; every folder ships an `.env.example` listing the keys
without values. The Apps Script jobs read Script Properties, set in the Apps
Script editor under Project Settings.

Vendor hostnames are placeholders here: `api.locker-vendor.example`,
`panel.kiosk-vendor.example`. The real ones are in the `.env` and the Script
Properties, not in the source.

## The Python jobs scrape

Neither locker back office offers an export worth having, so `export_incassi.py`
logs into a web panel and parses the table, and `export_depositi.py` calls a REST
API that is the vendor's *development* environment, because that is the one that
exists. Both break when the vendor changes a page. That is a known cost, written
down in each README rather than discovered twice.
