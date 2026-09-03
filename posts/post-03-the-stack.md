# Post 3 / The technical foundation

The first decision was not which tools to use. It was how little to spend. This
is a low margin business, and a stack with a fat monthly fee eats exactly the
margin I am trying to grow. There is a second risk too: overkill.

Reaching for a powerful tool when a simple one gets you to the same place. This
is an experiment, so I would rather start under equipped and add only what
proves it is needed. Here is what I am running today.

**WHY I STARTED SMALL**

- Monthly tool costs come straight out of a thin margin. Every subscription has to justify itself against that number.
- Overkill is a real risk right now. Powerful tool, simple job, no gain.
- Starting light means every upgrade later is an answer to a problem I actually hit.

**WHAT I CAN AND CANNOT DO**

- No programming background.
- I can build low code automations, but so far always with AI helping me do it.
- So I cannot judge which tool is the most efficient. I can only validate one by using it.

**THE STACK**

- Starting point: a setup recommended in a YouTube video, picked after comparing options.
- Obsidian as the company brain. About 40 atomic notes to start, linked to each other.
- A small Python script that enforces the rules, so every note keeps the same format and links.
- Claude Code on a capped budget. An 80 euro a month plan is a real cost against these margins, so I am not committing to it until the return is visible.
- Google Drive as the working layer. Sheets for reporting and as the base of the automations, with Google Scripts on top of them.

**WHAT I LEFT OUT**

- No RAG. No MCP. Neither solves a problem I have today.

**THE CODE**

Published, with credentials and vendor hostnames replaced by placeholders.

- [`stack/vault/`](../stack/vault/) — the rules the notes have to pass, the Python gate that enforces them, the templates, three real notes.
- [`stack/automations/`](../stack/automations/) — the jobs that pull the two locker back offices and the analytics tool into Sheets, and the review request loop.

Next post: The First Wow.
