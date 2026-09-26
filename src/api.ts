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
import { getTokenBalance } from "./stellar";
import { marketWhere, MARKET_ORDER, flattenProtocol } from "./curation";
import { adminRouter } from "./admin";

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

// The project has no validation library; this matches the hand-rolled parsing
// already used for the `limit` query param below.
function boolParam(value: unknown): boolean {
    return value === "true" || value === "1";
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
    const events = await prisma.marketEvent.findMany({
        where: { market: req.params.id },
        orderBy: { ledger: "desc" },
    });
    res.json(events.map(toMarketEventJson));
});

app.get("/vaults/:address/rate-history", async (req, res) => {
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

app.get("/accounts/:address/balances", async (req, res) => {
    // Deliberately unfiltered by maturity: PT/YT in a matured market is
    // exactly what the holder still needs to see in order to redeem it.
    const markets = await prisma.market.findMany({
        where: { listed: true },
        select: {
            id: true,
            pt: true,
            yt: true
        },
    });

    const balances: AccountBalanceJson[] = await Promise.all(markets.map(async (market) => {
        const [ptBalance, ytBalance] = await Promise.all([
            getTokenBalance(market.pt, req.params.address),
            getTokenBalance(market.yt, req.params.address),
        ]);

        return {
            marketId: market.id,
            ptBalance: (ptBalance ?? 0n).toString(),
            ytBalance: (ytBalance ?? 0n).toString(),
        };
    }),);

    res.json(balances);
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
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const address = req.params.address;
    const events = await prisma.marketEvent.findMany({
        where: {
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
        include: {
            protocol: true,
            markets: { where: marketWhere(now), orderBy: MARKET_ORDER },
        },
    });

    res.json(vaults.map((vault) => toVaultJson(vault, now)));
});

// Single vault with its curated metadata. The market details page needs this
// given only a `market.vault` address, and a 404 distinguishes an unknown
// vault from one that simply has no listed markets.
app.get("/vaults/:address", async (req, res) => {
    const now = nowSecs();
    const vault = await prisma.vault.findUnique({
        where: { address: req.params.address },
        include: {
            protocol: true,
            markets: { where: marketWhere(now), orderBy: MARKET_ORDER },
        },
    });

    if (!vault) return res.status(404).json({ error: "vault not found" });

    res.json(toVaultJson(vault, now));
});

app.get("/status", async (req, res) => {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });

    const body: IndexerStatusJson = {
        lastPolled: iso(state?.lastPolled ?? null),
        lastLedger: state?.lastLedger ?? null,
    };
    res.json(body);
});

app.get("/events", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const events = await prisma.factoryEvent.findMany({
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events.map(toFactoryEventJson));
});

app.get("/vaults/:address/events", async (req, res) => {
    const events = await prisma.factoryEvent.findMany({
        where: { vault: req.params.address },
        orderBy: { ledger: "desc" },
    });
    res.json(events.map(toFactoryEventJson));
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`YBC API running on :${PORT}`));
