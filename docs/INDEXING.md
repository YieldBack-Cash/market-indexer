# How indexing works, and how it fails

Notes begun after the 2026-09-09 incident, where the indexer silently stopped
seeing new markets for weeks without a single error in the logs, and revised on
2026-09-30 when the poller was rebuilt around what the RPC actually does.

---

## The model: polling, not subscribing

There is no live subscription to the chain. `syncEvents()` (`src/indexer.ts`)
runs in a plain loop (`src/scheduler.ts`, every `POLL_INTERVAL_MS`, default 5 s)
and asks Soroban RPC one question:

> Give me every event emitted by these contracts, from ledger N to your tip.

The contracts are the factory, the router, and the YM and pool of every market
already in the database. `N` is `IndexerState.lastLedger + 1`, a cursor
persisted in Postgres so a restart resumes where it left off. Before asking, the
poller makes one cheap `getHealth` call; if the RPC's tip has not moved since
the last poll, it asks nothing else.

## What the RPC actually does, and what the poller does about it

Two RPC behaviours shape `fetchEvents` (`src/stellar.ts`). Both were measured
against `soroban-testnet.stellar.org` on 2026-09-30.

**A request scans at most 10,000 ledgers.** Whether or not it finds events, it
stops there and returns a cursor for continuing. A request from ledger 4906515
returned four events and a cursor at 4916514, with the chain at 4924595; the
events that existed at 4923463 were simply not in the answer. The previous poller
only followed the cursor when a page was full, so from a cursor more than 10,000
ledgers behind the tip it could not see anything near the tip. `fetchEvents`
now follows the cursor until the scan reaches the `latestLedger` the RPC reports
in the same response, so one poll always covers the whole distance to the tip.

**A request takes up to five filters of five contracts.** Twenty-five contracts
travel in one request; the previous poller sent one request per five contracts.

## The cursor is where the scan ended, not where the last event was

The old poller advanced `lastLedger` only to the ledger of the last event it
saw. A quiet poll therefore moved it by one ledger, every five seconds, while
the chain moved at the same rate: whatever gap existed was frozen, and after an
outage it could take a day to walk back to the tip, or never.

`lastLedger` is now `scannedTo`: the ledger the RPC's scan actually reached,
which after a complete poll is the tip. A quiet poll lands at the tip. A restart
after an outage catches up in one poll, however long the outage was, as long as
the RPC still has the ledgers.

## RPC retention

The RPC keeps a bounded window of history and reports its edges in `getHealth`
(`oldestLedger`, `latestLedger`). On testnet the window was about 121,000
ledgers, roughly a week, on 2026-09-30. Older RPC builds returned an empty list
for a `startLedger` below the window, and that was the whole 2026-09-09
incident: the cursor had drifted below the boundary during downtime, every poll
was handed `[]`, logged `Fetched 0 event(s)`, advanced one ledger, and asked
again, forever, while the service looked perfectly healthy.

Now, when the cursor is older than `oldestLedger`, the poller logs a
`[retention]` error naming how many ledgers are unrecoverable, jumps to
`oldestLedger`, and continues. The events in the gap are gone from this RPC;
recovering them means another data source (an archive RPC, Hubble/Galexie) or
re-creating what they described. The point is that the loss is loud and
bounded, not silent and growing.

## Health is lag, not liveness

`GET /status` reports `lastLedger`, the RPC's `latestLedger`, their difference
as `lagLedgers`, and `inRetention`. A healthy poller shows a lag of zero to a
few ledgers. Alert on lag, not on the process being up: the failure mode of
this system is polling on schedule and seeing nothing.

## Ordering within a batch

Events are applied in ledger order, then by event id within a ledger. Ids are
fixed-width TOIDs, so a plain string compare gives the chain's emission order.
A router event that names a market created earlier in the same ledger is applied
after the creation, and the creation registers the market id immediately, so
the router event is not skipped as unknown.

## The market's name comes from the factory

`MarketCreated` carries the market's name (`bvXLM-23DEC2026`); the indexer
stores it after sanitising it. The old `underlying symbol + date` construction
is kept only as a fallback for factories from before the name existed, and it
produced indistinguishable names (`XLM-2026-12-23` for both a Blend and a XOXNO
market).

**Nothing a vault says is stored raw.** The factory builds the name from the
vault's own `symbol()`, and the underlying symbol comes from whichever contract
the vault names as its asset, so both are the vault's choice and nothing on
chain bounds them. `sanitizeLabel` (`src/cursor.ts`) strips control, format,
bidi and zero-width characters, collapses whitespace and cuts a symbol to 32
characters and a name to 64, falling back to the vault's address prefix when
nothing printable is left. A hostile vault can still pick a misleading symbol;
curation is the control for that. It cannot put a terminal escape on the
curator's screen or a megabyte in a row.

---

## The API serves listed markets only

`listed` gates every public route. The market lists and the balances always
were; since 2026-09-30 so are `/vaults`, `/vaults/:address`, its rate history
and factory events, `/markets/:id/events`, `/accounts/:address/events` and
`/events`. A vault is visible while at least one of its markets is listed; an
unlisted market or vault is a 404 like an unknown one, so the API does not
confirm what the factory has seen. `limit` is a whole number from 1 to 500 or a
400 (a negative value used to reach Postgres and turn the cap off), every list
is capped, and a handler that throws is logged in full and answered with
`{"error":"internal error"}` and nothing else.

---

## Event decoding is positional, and that bit us too

Same incident, second bug. `decodeFactoryEvent` read the vault from `topics[1]`.
The factory's `MarketCreated` later gained a `#[topic] creator: Address` **ahead
of** `vault`, shifting every index by one. The decoder began reading the creator's
account address as the vault and filed whole markets under a `G...` address.

No error — it wrote coherent, entirely wrong rows.

Fixed by reading `vault` out of the event's data payload instead of a topic
position (`src/events.ts`). The payload carries it in both the old and new event
shapes, so it cannot drift again.

**The lesson generalizes:** topic indices are positional and the contract can
reorder them without any signal to consumers. The `vec`-format data payloads
have the same problem: an inserted or reordered struct field shifts every value
after it, and a positional destructure writes coherent, wrong rows.

**Since then the layouts are generated, not typed.** `#[contractevent]` writes
each event's data format and parameter order into the contract binary's spec.
`npm run gen:events` reads that spec out of the release WASMs
(`src/spec/genEventLayouts.ts`, sibling `ybc-contracts` checkout or
`YBC_CONTRACTS_DIR`) into `src/eventLayouts.generated.ts`, and `src/events.ts`
decodes by those layouts and derives its result types from them. Three
consequences:

- A `vec` payload whose length doesn't match its layout throws, and the
  indexer stores the event undecoded, instead of misreading it.
- After a contract change, `npm run check:events` (and the parity test, when
  the binaries are present) fails until the file is regenerated; a renamed or
  removed field then fails `tsc` at every consumer.
- Fields the contracts appended to events already on chain (`fee`,
  `reserve_fee`) and the prepended `creator` topic are the only tolerated
  shape differences, listed by name in `src/events.ts`.

## The router is indexed too

Every zap through the app runs through the router, and the router publishes one
event per user-facing action, named after the entrypoint that emitted it:
`zap_asset_for_pt`, `zap_pt_for_asset`, `zap_asset_for_yt`, `zap_yt_for_asset`,
`zap_asset_for_split`, `zap_split_for_asset`, `zap_asset_for_lp`,
`zap_lp_for_asset`, `swap_v_for_yt`, `swap_yt_for_v`, `exit_expired` and
`exit_expired_to_asset`. Each carries the asset (where the action is
denominated in it) and what actually moved: asset amounts are the user's
measured balance change, net of every refund and sweep, and token amounts what
was asked for and received; the caller's bounds are not repeated. Each names
its market by `vault` and `maturity`, so they are stored as `MarketEvent` rows
with `source = "router"` under that market, next to the yield-manager and pool
events from the same transaction. (Routers deployed before 2026-09-30 published
`zap_in` / `zap_out` legs and `routed_yt_buy` / `routed_yt_sell` instead; rows
from them stay as they were written.)

Set `ROUTER_CONTRACT_ADDRESS` to enable it. The frontend's history uses a router
row, when the transaction has one, for the action label and the asset leg,
instead of inferring both from share-denominated inner events and an hourly
rate; it only falls back to inference for transactions that did not go through
the router.

---

## Operational notes

**Stop the service before touching the cursor.** The poller runs every 5 seconds
and would consume events between your `UPDATE` and your restart. Correct order:

```bash
systemctl stop ybc-indexer
psql "$DATABASE_URL" -c 'UPDATE "IndexerState" SET "lastLedger" = <ledger> WHERE id = 1;'
systemctl start ybc-indexer
```

With the cursor now landing at the tip on every poll, the only reason to touch
it is a deliberate replay from an earlier ledger (a fresh database, or events
that were ingested wrongly). Set it to one below the first ledger you want
re-read.

**Re-processing needs the FactoryEvent row deleted.** `applyFactoryEvent` skips
anything already recorded by `raw.id`, so rewinding the cursor alone will not
re-apply an event that was ingested wrongly.

**The service runs compiled output** (`ExecStart=/usr/bin/node dist/scheduler.js`),
so source changes need `npm run build` before a restart. `.env` is read once at
start-up by `dotenv/config`, so an `.env` edit needs a restart too. The factory
and router addresses are read from the environment on every poll rather than
captured at import, so the API process does not depend on them at all and does
not need restarting when they change.

**No Redis.** The scheduler is a loop in the process; BullMQ and Redis were
removed on 2026-09-30. A `REDIS_*` line left in `.env` is ignored. The Redis
service on the box can be stopped and disabled.

**Fresh database.** With no `IndexerState` row the first poll starts from
`START_LEDGER`; unset or empty means the current tip. Set it to the ledger of
the first deployment you want indexed; the first poll fetches everything from
there to the tip in one pass.
