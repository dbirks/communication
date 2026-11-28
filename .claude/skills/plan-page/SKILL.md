---
name: plan-page
description: Communicate plans, research, reviews and decision points to David as one standalone HTML page in the Communication UI style, served on the tailnet. Use whenever a plan, design, long explanation or a set of decisions needs his input or sign-off, and before implementing anything planned.
---

# Plan page: talk to David through one living HTML page

David reads long plans and decisions on a page, not in the terminal. Keep **one** page per topic, rewrite it
fearlessly as things change, and never let it go stale.

## Where

- File: `~/.cache/pi-orch/communication/plan/index.html` (one page; add `<topic>.html` beside it only for a
  separate topic, and link it from `index.html`). Not in the repo: it is a one-off.
- Served by a local static server plus a tailnet proxy (serving a folder directly needs root; proxying does not,
  once David's user is a Tailscale operator — he has run `sudo tailscale set --operator=$USER`):
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18950/` — if not 200 (e.g. after a reboot), start it:
    `(nohup python3 -m http.server 18950 --bind 127.0.0.1 --directory ~/.cache/pi-orch/communication/plan > ~/.cache/pi-orch/communication/plan-server.log 2>&1 &)`
  - `tailscale serve --bg --set-path /plan http://127.0.0.1:18950` (persists across reboots; check with
    `tailscale serve status`).
- Address to give David: the **full MagicDNS host name**, never an IP. Get it with
  `tailscale status --self --json` (`Self.DNSName`), e.g. `https://spruce-goose.beluga-wyvern.ts.net/plan/`.
  Check it answers (`curl -s -o /dev/null -w '%{http_code}'`) before sending it.

## Look (the Communication UI)

- Background `#f8f7f3`, surfaces white, ink `#1e1d1a`, muted `#6b675e`, lines `#e6e2d9` / `#f0ede6`,
  accent `#2f4bd6` (wash `#f6f7fe`), status colours done `#1f6b37`, running `#1a6da6`, waiting `#f0a93a`,
  failed `#b0281a` — the tokens in `ui/src/styles/tokens.css`.
- Red Hat Text for words, Red Hat Mono for ids, paths and code (Google Fonts). Radius 10–12, hard tonal
  offset shadows (`2px 2px 0 #ece9e2`), no soft blur shadows.
- Works at phone width (David reads it on his phone): single column under 760px, no sideways scroll.
- Draw at least one inline SVG diagram when there is structure or flow to show.

## Words (ASD-STE100, about 70%)

- Short sentences, one idea each. Active voice. Common words. Same word for the same thing every time.
- Define product words once in a "Words" table (serve, worker, lease…).
- No hedging; say what you will do.

## Shape of the page

1. Header: title, "updated <date> · rev N".
2. **Status now**: running / your input / done tags, one line each.
3. Words, then the picture (diagram).
4. What we found (facts with `file:line`).
5. **Decisions for you**: each with an id (D1…), options, the recommended one highlighted, who agrees
   (Claude, Codex/AGY reviewer).
6. The plan, short (numbered steps).
7. Review log (rounds with the reviewer, what changed).
8. How to reply (e.g. "D1 A, D2 B").

## Rules

- Update the page (bump rev and date) every time the plan, status or a decision changes; delete what is stale.
- When David's input is needed, send the full tailnet URL in the chat with one line saying what to look at.
- Get his sign-off on the page's decisions **before** implementing.
- Never put secrets, tokens or private data on the page.
