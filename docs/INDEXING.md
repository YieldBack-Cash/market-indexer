# How indexing works, and how it fails

Notes written after the 2026-09-09 incident, where the indexer silently stopped
seeing new markets for weeks without a single error in the logs.

---

## The model: polling, not subscribing

There is no live subscription to the chain. `syncEvents()` (`src/indexer.ts`) runs
every 5 seconds on a BullMQ repeat job and asks Soroban RPC one question:

> Give me every event emitted by these contracts, starting at ledger N.

The contracts are the factory plus the YM and pool of every market already in the
database (`src/indexer.ts:175`). `N` is `IndexerState.lastLedger + 1` — a cursor
persisted in Postgres so a restart resumes where it left off.

Two properties follow, and most of the confusion about this system comes from
mixing them up:

1. **The scan runs to the tip, not to `N`.** `getEventsFor` pages forward until it
   runs out (`src/stellar.ts:161`). So a poll starting at a cursor an hour old
   still returns anything that happened one second ago. **Cursor lag does not
   delay detection.** A market created right now is indexed on the next poll,
   ~5 seconds later, no matter how far back the cursor sits.
2. **The cursor only marks where reading begins.** It is not a measure of how
   current the data is.

---

## The cursor barely moves

```ts
let highestLedger = startLedger;                          // indexer.ts:188
for (const raw of rawEvents) {
    highestLedger = Math.max(highestLedger, raw.ledger);  // indexer.ts:191
}
// ...
data: { lastPolled: new Date(), lastLedger: highestLedger }
```

`highestLedger` is raised only by the ledger numbers of **events that came back**.
Most polls return nothing, so it stays at its initial value — `lastLedger + 1`.

A quiet poll therefore advances the cursor by exactly **one ledger**. Polls run
every 5 seconds; Stellar closes a ledger every ~5 seconds. The cursor and the
chain move at the same rate, so **whatever gap exists is frozen** — the indexer
never falls further behind under normal operation, and never catches up either.

Measured on 2026-09-09: cursor 4569411 → 4569669 over 1290 seconds. 258 ledgers,
exactly one per poll.

The number needed to fix this is already in hand and thrown away: RPC returns
`latestLedger` on every `getEvents` response, and `getEventsFor` discards it,
returning only `rpc.Api.EventResponse[]`.

---

## RPC retention, and the silent failure

Soroban RPC keeps only a short window of event history. On
`soroban-testnet.stellar.org`, measured by binary search on 2026-09-09:

```
retention boundary   ledger 4582773
chain tip            ledger 4593368
window               10,595 ledgers  ~=  14.7 hours
```

**A `startLedger` below that boundary returns an empty list, not an error.**

That is the whole incident in one sentence. The indexer's cursor had drifted
12,767 ledgers below the boundary during some earlier downtime. Every poll asked
for a window RPC no longer had, was handed `[]`, logged `Fetched 0 event(s)`,
advanced the cursor by one, and asked again. Forever.

It looked completely healthy. The service was up, polling on schedule, logging
every 5 seconds, `lastPolled` current. It just could not see anything, and had no
way to say so.

Verified directly against the same contract at the same moment:

```
startLedger 4585000  ->  1 event   (the market_created we were missing)
startLedger 4580000  ->  0 events
startLedger 4570001  ->  0 events   <- where the cursor was stuck
```

Same contract, same chain state. The only variable is where the read begins.

### Why it cannot self-heal

Once below the boundary, the cursor advances one ledger per poll while the
boundary advances one per 5 seconds — the same rate. The gap never closes. Only a
manual `UPDATE "IndexerState" SET "lastLedger" = ...` gets it back inside the
window.

### What is lost

Events that scroll past the boundary while the cursor is stranded are gone from
RPC permanently. The 2026-08-17 `market_created` for the 2027 market was lost
this way and had to be recovered by other means. Recovery beyond the window means
Hubble/Galexie, or re-creating the market.

---

## Tradeoffs in the current design

**What the cursor lag costs**

- Re-reading the same span every poll. At a 582-ledger gap that is ~12 redundant
  scans a minute, forever.
- `lastLedger` reads like progress but is really just a floor that crawls. It is
  not a health signal, and today it looked fine while nothing worked.
- A shrinking safety margin. With the window at ~10,600 ledgers and a 582-ledger
  gap, roughly 13.9 hours of downtime is enough to fall out of retention and fail
  silently again.

**What it does not cost**

- Detection latency. New markets still appear within ~5 seconds. Worth repeating,
  because the instinct is to assume a lagging cursor means late data. It does not.

**The fix**

Return `latestLedger` from `getEventsFor` and use it as the cursor when a poll
comes back empty. Then a quiet poll jumps straight to the tip, the gap collapses
to zero, retention stops mattering, and a restart after any outage resumes at the
tip instead of somewhere unreachable.

**Worth having regardless**

- An alert on `tip - lastLedger` exceeding some fraction of the retention window.
  The failure mode is silence, so absence of errors proves nothing.
- Treat an empty result from a `startLedger` older than the window as an error
  rather than as "no events" — compare `startLedger` against `latestLedger` minus
  the known window and log loudly.

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

Every zap through the app runs through the router, and the router publishes its
own events: `zap_in` / `zap_out` with the exact base-asset amounts that crossed
the vault boundary, `routed_yt_buy` / `routed_yt_sell`, and the two expired
exits. Each names its market by `vault` and `maturity`, so they are stored as
`MarketEvent` rows with `source = "router"` under that market, next to the
yield-manager and pool events from the same transaction.

Set `ROUTER_CONTRACT_ADDRESS` to enable it. The frontend's history uses a router
row, when the transaction has one, for the action label and the asset leg,
instead of inferring both from share-denominated inner events and an hourly
rate; it only falls back to inference for transactions that did not go through
the router.

---

## Operational notes

**Stop the service before touching the cursor.** The poller runs every 5 seconds
and will happily consume events with the old code between your `UPDATE` and your
`systemctl restart`. Correct order:

```bash
systemctl stop ybc-indexer
psql "$DATABASE_URL" -c 'UPDATE "IndexerState" SET "lastLedger" = <ledger> WHERE id = 1;'
systemctl start ybc-indexer
```

**Re-processing needs the FactoryEvent row deleted.** `applyFactoryEvent` skips
anything already recorded by `raw.id` (`src/indexer.ts:55`), so rewinding the
cursor alone will not re-apply an event that was ingested wrongly.

**The service runs compiled output** (`ExecStart=/usr/bin/node dist/scheduler.js`),
so source changes need `npm run build` before a restart. `.env` changes do not —
`dotenv/config` reads it at runtime. But env vars are captured at module load
(`const FACTORY_ADDRESS = process.env...`, `indexer.ts:22`), so an `.env` edit
still requires a restart.
