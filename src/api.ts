import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient, FactoryEvent, Market, MarketEvent, Vault, Protocol } from "@prisma/client";
import type {
    AccountBalanceJson,
    FactoryEventJson,
    IndexerStatusJson,
    MarketEventJson,
    MarketEventSource,
    MarketJson,
    VaultJson,
    VaultRateSnapshotJson,
} from "./protocol/protocol";
import rateLimit from "express-rate-limit";
import { getChainHealth, getTokenBalance } from "./stellar";
import { marketWhere, MARKET_ORDER, flattenProtocol } from "./curation";
import { adminRouter } from "./admin";
import { LIMIT_ERROR, limitParam, MAX_LIMIT } from "./params";

const app = express();
// Behind nginx, req.ip is the proxy's address unless we trust one hop — without
// this the rate limiter buckets every client together.
app.set("trust proxy", 1);
app.use(
    cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" }),
);
const prisma = new PrismaClient();

// Mounted ahead of the public limiter: a bulk curation session would other-
// wise burn the 60/min public budget. The admin router brings its own.
app.use("/admin", adminRouter(prisma));

app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// Evaluated per request so `isActive` reflects the current time, not server
// boot time.
function nowSecs(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
}

// The project has no validation library; the two query parameters it takes
// are parsed by hand, strictly.
function boolParam(value: unknown): boolean {
    return value === "true" || value === "1";
}


// Only curated markets leave this API (O-23). `listed` already gated the market
// lists and the balances; these helpers gate everything else, so a market the
// factory has seen but nobody has reviewed is not reachable by another client
// either. A vault is visible while at least one of its markets is listed.
const LISTED_VAULT = { markets: { some: { listed: true } } } as const;

async function isListedMarket(id: string): Promise<boolean> {
    return (await prisma.market.count({ where: { id, listed: true } })) > 0;
}

async function isListedVault(address: string): Promise<boolean> {
    return (await prisma.vault.count({ where: { address, ...LISTED_VAULT } })) > 0;
}

async function listedMarketIds(): Promise<string[]> {
    const rows = await prisma.market.findMany({ where: { listed: true }, select: { id: true } });
    return rows.map((r) => r.id);
}

async function listedVaultAddresses(): Promise<string[]> {
    const rows = await prisma.vault.findMany({ where: LISTED_VAULT, select: { address: true } });
    return rows.map((r) => r.address);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const big = (b: bigint | null) => (b === null ? null : b.toString());

// Every response is built field by field against the wire types in
// src/protocol/protocol.ts, never by spreading a Prisma row: a column the schema gains is
// not sent until it is declared, a column the frontend expects is a type error
// here the moment the schema loses it, and internal review copy (curation
// notes) cannot leak by accident.
function toMarketJson(market: Market, now: bigint): MarketJson {
    return {
        id: market.id,
        vault: market.vault,
        name: market.name,
        ym: market.ym,
        pt: market.pt,
        yt: market.yt,
        pool: market.pool,
        maturity: market.maturity.toString(),
        creator: market.creator,
        verified: market.verified,
        listed: market.listed,
        curatedAt: iso(market.curatedAt),
        currentApy: big(market.currentApy),
        apyMin: big(market.apyMin),
        apyMax: big(market.apyMax),
        feeApy: big(market.feeApy),
        reserveFeeRate: big(market.reserveFeeRate),
        lpFeeApy: big(market.lpFeeApy),
        lpFeeApyUpdatedAt: iso(market.lpFeeApyUpdatedAt),
        createdAt: market.createdAt.toISOString(),
        updatedAt: market.updatedAt.toISOString(),
        isActive: market.maturity > now,
    };
}

type VaultWithRelations = Vault & {
    protocol: Protocol | null;
    markets?: Market[];
};

function toVaultJson(vault: VaultWithRelations, now: bigint): VaultJson {
    return {
        address: vault.address,
        createdAt: vault.createdAt.toISOString(),
        updatedAt: vault.updatedAt.toISOString(),
        underlyingSymbol: vault.underlyingSymbol,
        underlyingAsset: vault.underlyingAsset,
        pool: vault.pool,
        displayName: vault.displayName,
        description: vault.description,
        riskText: vault.riskText,
        protocolId: vault.protocolId,
        curatedAt: iso(vault.curatedAt),
        ...flattenProtocol(vault.protocol),
        ...(vault.markets === undefined
            ? {}
            : { markets: vault.markets.map((m) => toMarketJson(m, now)) }),
    };
}

function toMarketEventJson(e: MarketEvent): MarketEventJson {
    return {
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt.toISOString(),
        source: e.source as MarketEventSource,
        type: e.type,
        txHash: e.txHash,
        contractId: e.contractId,
        market: e.market,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
    };
}

function toFactoryEventJson(e: FactoryEvent): FactoryEventJson {
    return {
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt.toISOString(),
        type: e.type,
        txHash: e.txHash,
        vault: e.vault,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
    };
}

app.get("/markets", async (req, res) => {
    const now = nowSecs();
    const markets = await prisma.market.findMany({
        where: marketWhere(now, {
            includeExpired: boolParam(req.query.includeExpired),
        }),
        orderBy: MARKET_ORDER,
    });

    res.json(markets.map((m) => toMarketJson(m, now)));
});

app.get("/markets/:id/events", async (req, res) => {
    const limit = limitParam(req.query.limit, MAX_LIMIT);
    if (limit === null) return res.status(400).json(LIMIT_ERROR);
    if (!(await isListedMarket(req.params.id))) return res.status(404).json({ error: "market not found" });
    const events = await prisma.marketEvent.findMany({
        where: { market: req.params.id },
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events.map(toMarketEventJson));
});

// Unbounded on purpose: the indexer writes one snapshot an hour, so nobody
// outside this process can grow the list.
app.get("/vaults/:address/rate-history", async (req, res) => {
    if (!(await isListedVault(req.params.address))) return res.status(404).json({ error: "vault not found" });
    const snapshots = await prisma.vaultRateSnapshot.findMany({
        where: { vault: req.params.address },
        orderBy: { timestamp: "asc" },
        select: { rate: true, timestamp: true },
    });
    const body: VaultRateSnapshotJson[] = snapshots.map((s) => ({ rate: s.rate, timestamp: s.timestamp.toISOString() }));
    res.json(body);
});

app.get("/vaults/:address/markets", async (req, res) => {
    const now = nowSecs();
    const markets = await prisma.market.findMany({
        where: {
            ...marketWhere(now, {
                includeExpired: boolParam(req.query.includeExpired),
            }),
            vault: req.params.address,
        },
        orderBy: MARKET_ORDER,
    });

    res.json(markets.map((m) => toMarketJson(m, now)));
});

// Balances are two simulated contract calls per listed market, so a page that
// refetches on focus used to cost 2N RPC round-trips each time. A balance can
// only change when a ledger closes, so the answer is kept per (address, ledger)
// and re-read only once the chain has moved. Bounded so an address scan cannot
// grow it without limit.
const BALANCE_CACHE_MAX = 500;
const balanceCache = new Map<string, AccountBalanceJson[]>();

async function balancesFor(address: string, ledger: number): Promise<AccountBalanceJson[]> {
    const key = `${address}:${ledger}`;
    const hit = balanceCache.get(key);
    if (hit) return hit;

    // Deliberately unfiltered by maturity: PT/YT in a matured market is
    // exactly what the holder still needs to see in order to redeem it.
    const markets = await prisma.market.findMany({
        where: { listed: true },
        select: { id: true, pt: true, yt: true },
    });
    const balances: AccountBalanceJson[] = await Promise.all(markets.map(async (market) => {
        const [ptBalance, ytBalance] = await Promise.all([
            getTokenBalance(market.pt, address),
            getTokenBalance(market.yt, address),
        ]);
        return {
            marketId: market.id,
            ptBalance: (ptBalance ?? 0n).toString(),
            ytBalance: (ytBalance ?? 0n).toString(),
        };
    }));

    if (balanceCache.size >= BALANCE_CACHE_MAX) {
        balanceCache.delete(balanceCache.keys().next().value!);
    }
    balanceCache.set(key, balances);
    return balances;
}

app.get("/accounts/:address/balances", async (req, res) => {
    const { latestLedger } = await getChainHealth();
    res.json(await balancesFor(req.params.address, latestLedger));
});

// One wallet's own activity across every market, newest first: the market events
// whose payload names it. The AMM's swaps and LP events use `to`, the YM's split /
// combine / redeem use `from`, its flash (YT) legs and claims use `user` / `to`.
// Powers the frontend's Positions history; without it the app has to pull every
// market's full feed and filter client-side.
// TODO: the payload JSON-path filter has no index, so this scans every MarketEvent row.
// Fine at testnet volume; if it gets slow, add expression indexes on
// payload->>'to' / 'from' / 'user' (raw SQL migration, Prisma can't express them).
app.get("/accounts/:address/events", async (req, res) => {
    const limit = limitParam(req.query.limit, 200);
    if (limit === null) return res.status(400).json(LIMIT_ERROR);
    const address = req.params.address;
    const events = await prisma.marketEvent.findMany({
        where: {
            market: { in: await listedMarketIds() },
            OR: ["to", "from", "user"].map((key) => ({
                payload: { path: [key], equals: address },
            })),
        },
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events.map(toMarketEventJson));
});

app.get("/vaults", async (req, res) => {
    const now = nowSecs();
    const vaults = await prisma.vault.findMany({
        where: LISTED_VAULT,
        include: {
            protocol: true,
            markets: { where: marketWhere(now), orderBy: MARKET_ORDER },
        },
    });

    res.json(vaults.map((vault) => toVaultJson(vault, now)));
});

// Single vault with its curated metadata. The market details page needs this
// given only a `market.vault` address. A vault with no listed market is a 404
// like an unknown one: the API does not confirm what the factory has seen.
app.get("/vaults/:address", async (req, res) => {
    const now = nowSecs();
    const vault = await prisma.vault.findFirst({
        where: { address: req.params.address, ...LISTED_VAULT },
        include: {
            protocol: true,
            markets: { where: marketWhere(now), orderBy: MARKET_ORDER },
        },
    });

    if (!vault) return res.status(404).json({ error: "vault not found" });

    res.json(toVaultJson(vault, now));
});

// The poller's health is its distance from the tip, not whether it is polling:
// the 2026-09-09 outage polled on schedule for weeks while seeing nothing. So
// the status carries the tip and the lag, and a lag past the RPC's retention
// window is reported as such. The RPC fields are null if the RPC is unreachable,
// which is itself worth seeing here.
app.get("/status", async (req, res) => {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    const health = await getChainHealth().catch(() => null);
    const lastLedger = state?.lastLedger ?? null;

    const body: IndexerStatusJson = {
        lastPolled: iso(state?.lastPolled ?? null),
        lastLedger,
        latestLedger: health?.latestLedger ?? null,
        lagLedgers: health && lastLedger !== null ? Math.max(0, health.latestLedger - lastLedger) : null,
        inRetention: health && lastLedger !== null ? lastLedger >= health.oldestLedger : null,
    };
    res.json(body);
});

// Factory events for listed vaults, plus the factory's own (ownership, wasm
// hashes, fees), which name no vault.
app.get("/events", async (req, res) => {
    const limit = limitParam(req.query.limit, 100);
    if (limit === null) return res.status(400).json(LIMIT_ERROR);
    const events = await prisma.factoryEvent.findMany({
        where: { OR: [{ vault: null }, { vault: { in: await listedVaultAddresses() } }] },
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events.map(toFactoryEventJson));
});

app.get("/vaults/:address/events", async (req, res) => {
    const limit = limitParam(req.query.limit, MAX_LIMIT);
    if (limit === null) return res.status(400).json(LIMIT_ERROR);
    if (!(await isListedVault(req.params.address))) return res.status(404).json({ error: "vault not found" });
    const events = await prisma.factoryEvent.findMany({
        where: { vault: req.params.address },
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events.map(toFactoryEventJson));
});

// Anything that fell through is JSON too, and a handler that threw (Express 5
// forwards a rejected async handler here) is logged in full and answered with
// nothing but a status: the default handler would include the stack unless
// NODE_ENV happened to be "production" (O-6).
app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: "internal error" });
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`YBC API running on :${PORT}`));
