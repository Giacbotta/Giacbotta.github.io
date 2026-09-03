# gmail-feedback

Turns the receipt emails the kiosk sends into review requests. Two Apps Script
functions on one Google Sheet, no server, no external service.

## The loop

1. The kiosk emails a receipt to the customer; a Gmail filter puts the label
   `Onsite` on it.
2. `getEmailsToSheetOnsite()` copies the newest labelled messages into the
   `Onsite Extract` sheet, one row per message.
3. A formula in column G pulls the customer's first name out of the receipt body.
4. `sendFeedbackEmails()` sends one review request to every row that has an
   address in column D and nothing in column H, then writes the send date into
   column H.

## Sheet layout

| Col | Field | Written by |
| --- | --- | --- |
| A | Message ID | import |
| B | Date | import |
| C | Sender | import |
| D | Receiver | import |
| E | Subject | import |
| F | Body | import |
| G | Customer Name | sheet formula over F |
| H | Status | send |

## Why two dedup keys

Column A stops the same email being imported twice. Column H stops the same
customer being emailed twice. They guard different failures: clearing A only
costs a duplicate row, clearing H sends a second request to a real person. If
you ever rebuild the sheet, rebuild H first.

## Setup

1. Create the sheet `Onsite Extract` with the header row above.
2. Extensions > Apps Script, paste `Codice.gs`.
3. Edit the constants at the top: `REVIEW_URL`, `SENDER_NAME`, `WHATSAPP`,
   `GMAIL_LABEL`.
4. Run `getEmailsToSheetOnsite` once by hand and grant the Gmail and Sheets
   scopes.
5. Add a time-driven trigger for each function. Import more often than send.

## Limits

- `GmailApp.search` here fetches the 5 most recent threads. Enough for a
  trigger that runs hourly, not enough for a backfill.
- Gmail caps daily sends per account. `Utilities.sleep(200)` between messages
  keeps a normal day well inside it.
- Dates are shifted by `TIMEZONE_SHIFT_HOURS` because Gmail returns UTC. Set it
  to your offset, or switch to `Utilities.formatDate` with a timezone name if
  you cross a DST boundary and care about the hour.
