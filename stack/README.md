# The stack

What the system is built from today, and the code that runs it.

Two constraints shape every choice: a thin margin that will not carry
subscription costs, and no programming background. So the rule is to start under
equipped and add only what proves it is needed.

Everything here is what actually runs, with credentials, hostnames and contact
details replaced by placeholders. The comments and the READMEs are in Italian,
because that is the language the business runs in. The code is not.

## Components

| Layer | Tool | Job |
| --- | --- | --- |
| Company brain | Obsidian | Atomic notes, linked to each other. The single place the business is described. |
| Format enforcement | Python | A quality gate that refuses notes that break the rules. Rules over discipline. |
| Agent runtime | Claude Code | On a capped budget. Not committed to the 80 euro a month plan until the return is visible. |
| Working layer | Google Drive | Files and the day to day surface. |
| Reporting base | Google Sheets | Where the numbers live, and what the automations read and write. |
| Automation logic | Google Apps Script | Sits on top of the Sheets. No server to run or pay for. |
| Data collection | Python | Scrapes the two locker back offices, which have no usable export. |

## What is in here

| Path | What it is |
| --- | --- |
| [`vault/`](vault/) | The rules the company brain runs on, the quality gate that enforces them, the note templates, and three real notes as examples. |
| [`automations/`](automations/) | The jobs that pull data out of the locker panels and the analytics tool and land it in Sheets, plus the review request loop. |

## Deliberately left out

- **RAG.** No retrieval problem at this size.
- **MCP.** Nothing in the current setup needs it.

Both get revisited when a real problem asks for them, and the post that adds one
will say which problem it was.

## A note on quality

Nothing here is engineered. It is written by someone who cannot judge which tool
is most efficient and can only validate one by using it, with an AI doing the
typing. It works, it is small, and it is honest about where it breaks. The
READMEs carry the failure modes I have already paid for.
