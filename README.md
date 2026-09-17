# Brainrot Heist — Multiplayer

A real 6-player online version of Brainrot Heist: accounts, player-created
servers with join codes, shared-consent server deletion, automatic + manual
host transfer, a server-authoritative economy/hatching/PvP-stealing game, and
global leaderboards.

This is a genuine client/server rewrite, not the old single HTML file — it
needs a Node.js process running (locally or on a host) plus a database file
next to it. Read the **Limitations & what a production pass would add**
section before you point this at the public internet.

## Architecture

```
                     data/brainrot.db (SQLite)
                             |
                        server/db.js
                             |
        server/auth.js   server/serverManager.js   server/gameRoom.js
                \               |                    /
                 \              |                   /
                     server/index.js  (Express + ws)
                             |
                    public/index.html  (browser client)
```

- **server/db.js** — SQLite via Node's built-in `node:sqlite` (no native
  compilation, no extra dependency). Schema for `users`, `sessions`,
  `servers`, `server_members`.
- **server/auth.js** — signup/login, bcrypt password hashing (`bcryptjs`,
  pure JS), opaque bearer session tokens.
- **server/serverManager.js** — the server-authoritative lobby logic: unique
  codes, the 6-player cap, leaving, automatic host transfer on disconnect,
  manual host transfer, and shared-consent deletion voting. **This is the
  module the spec asked to be tested first** — see `test/serverManager.test.js`
  (27 tests) for every scenario listed, including forged-vote and
  direct-delete attempts.
- **server/gameRoom.js** — the live, in-memory, per-server game: each
  connected player gets one of 6 bases arranged in a hexagon, income accrual,
  server-rolled hatching, and PvP stealing where the *owner's own presence*
  near their plot interrupts a theft (there are no NPC guards in the
  multiplayer version — the other five players are the threat). Covered by
  `test/gameRoom.test.js` (9 tests) plus `scripts/ws-smoke.js`, which drives
  two real WebSocket clients end-to-end (hatch → undefended steal succeeds →
  defended steal fails).
- **server/layout.js** — the base/plot position math, written once and loaded
  by *both* the server (`require`) and the browser (`<script src="/layout.js">`)
  so "am I close enough to steal" means the same thing on both sides.
- **public/index.html** — the entire client: login/signup, server browser,
  lobby (members, host badge, transfer, delete-vote UI, copy code), and the
  Three.js game view.

## Install & run locally

Requires **Node.js 22.5+** (for built-in `node:sqlite`; check with `node -v`).

```bash
npm install
node server/index.js
```

Open **http://localhost:8787**. Create two accounts in two browser
windows/profiles to try multiplayer against yourself.

Environment variables (optional):
- `PORT` — default `8787`
- `DB_PATH` — default `./data/brainrot.db`

## Running the tests

```bash
npm test                    # or: node --test
node scripts/ws-smoke.js    # requires the server running separately, see below
```

The WebSocket smoke test needs a live server since it exercises the real
network protocol two simulated players use:

```bash
node server/index.js &
node scripts/ws-smoke.js
```

**36/36** `node --test` cases pass (server-manager + game-room), plus the
end-to-end WebSocket smoke test. What was verified and how:

| Requirement from the spec | Verified by |
|---|---|
| Unique codes, join, full-server rejection, concurrent joins | `serverManager.test.js` |
| Duplicate-membership prevention, reconnect flow | `serverManager.test.js` |
| Host auto-transfer on disconnect, manual transfer, no auto-regain on reconnect | `serverManager.test.js` |
| Host cannot delete alone; unanimous non-host approval required | `serverManager.test.js` |
| Single denial cancels; duplicate votes don't inflate approval; non-members/forged votes rejected | `serverManager.test.js` |
| Member leaving mid-vote recalculates the requirement; initiator leaving cancels it | `serverManager.test.js` |
| Host disconnecting mid-vote transfers host without auto-approving | `serverManager.test.js` |
| No client-callable "just delete it" shortcut exists | `serverManager.test.js` |
| Hatching cost/rarity, full-base and insufficient-funds handling, selling, income accrual | `gameRoom.test.js` |
| PvP stealing succeeds when undefended, fails when the owner is nearby | `gameRoom.test.js` **and** `scripts/ws-smoke.js` over a real socket |

## Deploying somewhere other than your laptop

This is a plain Node HTTP server with a WebSocket upgrade on the same port —
it runs on any Node host (Render, Railway, Fly.io, a $5 VPS, etc.).

1. Push this project to a git repo.
2. On the host: set the start command to `node server/index.js`, set `PORT`
   to whatever the platform requires (most inject it automatically), and
   mount/attach a persistent disk for `data/` — if the filesystem is
   ephemeral (common on PaaS free tiers), **all accounts and progress will
   reset on every deploy/restart**. Use a host with a persistent volume, or
   swap `db.js` for a managed Postgres/MySQL connection before going live.
3. Put it behind HTTPS (the platform's built-in TLS, or a reverse proxy like
   Caddy/nginx in front of it). Once the page loads over `https://`, the
   client automatically upgrades to `wss://` for the socket — no client
   change needed, that logic is already in `public/index.html`.
4. There is no build step — it's server-rendered-nothing plus one static
   HTML file, so "deploy" is just "run `node server/index.js` somewhere with
   the repo checked out and `npm install` run once."

## Design decisions worth knowing about

- **Deletion approval rule**: *every current member except whoever started
  the vote* must approve — matches the spec's 6-player example (5/5). The
  requirement is recalculated live against current membership, so someone
  leaving mid-vote can immediately satisfy (or unstick) it, per the spec's
  "recalculate" instruction.
- **The vote initiator is exempt permanently**, even if host status moves to
  someone else mid-vote (host disconnecting mid-vote transfers host but the
  *original* initiator stays excluded from the required-approvers list —
  otherwise "the new host" would have to approve their own predecessor's
  request, which seemed like the wrong default). This is a judgment call the
  spec didn't fully pin down; it's isolated to one line in
  `getDeletionStatus` if you want different behavior.
- **Disconnect vs. leave are different actions.** Closing the tab/losing
  connection (`markDisconnected`/`setOnline(false)`) preserves membership,
  economy, and base slot — you resume exactly where you left off, and your
  base is sitting there (undefended!) for others to raid while you're gone.
  Explicitly leaving (`leaveServer`) frees your base slot for a new player
  and removes you from the member list.
- **Economy is account-level, not per-server.** Your money/brainrots/eggs
  hatched live on your account (`users` table) and travel with you into
  whichever server you're actively playing in, matching the spec's
  ACCOUNT-vs-SERVER data split. Only one server can be "live" for you at a
  time (whichever one you have a socket open to).
- **node:sqlite is experimental** (Node flags it as such at startup — that
  warning is expected, not a bug). It was chosen over `better-sqlite3` to
  avoid native-module compilation entirely. If you outgrow a single SQLite
  file, `db.js` is the only file that would need to change.

## Limitations — read this before deploying publicly

This was built and tested to be **functionally correct against every
scenario in the spec**, not hardened for a public production launch. Gaps
you'd want to close before that:

- **Session tokens never expire** and there's no rate limiting on
  login/signup — add expiry + a login-attempt limiter before going public.
- **Movement is client-reported with light server-side clamping**
  (rejecting/clamping any position jump faster than the max run speed
  allows), not a fully server-simulated physics model. This is enough to
  stop naive "teleport across the map" cheating but not a determined,
  custom-client cheater. Money, item ownership, hatch rarity, and steal
  outcomes are fully server-authoritative regardless — that's the part that
  actually matters for fairness, and nothing in the client is trusted for
  those.
- **No input validation hardening/CSRF protection** beyond what's shown
  (username/password shape checks, JSON body parsing). Fine for a small
  group of friends; add a proper validation layer for anything public.
- **Single-process, single-SQLite-file.** Fine up to quite a lot of
  concurrent small lobbies on one machine; horizontal scaling would need a
  shared database (Postgres) and a pub/sub layer (Redis) between server
  instances for the WebSocket broadcasts.
- **No automated browser test.** Everything server-side (the actual
  hard/security-relevant part) is covered by the 36 automated tests plus a
  scripted two-client WebSocket run. The `public/index.html` UI was checked
  for JavaScript syntax errors and exercises the exact same REST/WebSocket
  protocol those tests already drive — but nobody has clicked the actual
  buttons in a real browser. Sanity-check the UI yourself before relying on
  it.
