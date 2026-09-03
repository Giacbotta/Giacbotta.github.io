# The stack

What the system is built from today. Documentation, not a runnable project.
Every choice below is constrained by two things: a thin margin that will not carry
subscription costs, and the fact that I have no programming background.

## Principle

Start under equipped. Add only what proves it is needed.
Every upgrade should be an answer to a problem I actually hit, not a precaution.

## Components

| Layer | Tool | Job |
| --- | --- | --- |
| Company brain | Obsidian | About 40 atomic notes, linked to each other. The single place the business is described. |
| Format enforcement | Python script | Keeps every note in the same structure. Rules over discipline. |
| Agent runtime | Claude Code | On a capped budget. Not committed to the 80 euro a month plan until the return is visible. |
| Working layer | Google Drive | Files and the day to day surface. |
| Reporting and automation base | Google Sheets | Where the numbers live, and what the automations read and write. |
| Automation logic | Google Apps Script | Sits on top of the Sheets. |

## Deliberately left out

- **RAG.** No retrieval problem at 40 notes.
- **MCP.** Nothing in the current setup needs it.

Both get revisited when a real problem asks for them, and the post that adds one
will say which problem it was.

## Agents planned

One job each. Pricing, ads, support, content, monitoring.
I decide. They execute and report.

## Code

The scripts referenced above are not published here yet. They land in this folder
as each one stabilises, with the post that describes it.
