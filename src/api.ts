import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient, Market, Vault } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { getTokenBalance } from "./stellar";
import { marketWhere, MARKET_ORDER } from "./curation";
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

function toMarketJson(market: Market, now: bigint) {
    // res.json cannot serialize BigInt, and Market carries several (maturity,
    // the apy columns), so stringify them all rather than naming each one.
    const serialized = Object.fromEntries(
        Object.entries(market).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
        ]),
    );

    // Curation notes are internal review copy — never expose them publicly.
    delete serialized.curationNote;

    return {
        ...serialized,
        isActive: market.maturity > now,
    };
}

type VaultWithMarkets = Vault & { markets?: Market[] };

function toVaultJson(vault: VaultWithMarkets, now: bigint) {
    const { curationNote, markets, ...rest } = vault;

    return {
        ...rest,
        ...(markets === undefined
            ? {}
            : { markets: markets.map((m) => toMarketJson(m, now)) }),
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
    res.json(events);
});

app.get("/vaults/:address/rate-history", async (req, res) => {
    const snapshots = await prisma.vaultRateSnapshot.findMany({
        where: { vault: req.params.address },
        orderBy: { timestamp: "asc" },
        select: { rate: true, timestamp: true },
    });
    res.json(snapshots);
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

    const balances = await Promise.all(markets.map(async (market) => {
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

app.get("/vaults", async (req, res) => {
    const now = nowSecs();
    const vaults = await prisma.vault.findMany({
        include: {
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
            markets: { where: marketWhere(now), orderBy: MARKET_ORDER },
        },
    });

    if (!vault) return res.status(404).json({ error: "vault not found" });

    res.json(toVaultJson(vault, now));
});

app.get("/status", async (req, res) => {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });

    res.json({
        lastPolled: state?.lastPolled ?? null,
        lastLedger: state?.lastLedger ?? null,
    });
});

app.get("/events", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const events = await prisma.factoryEvent.findMany({
        orderBy: { ledger: "desc" },
        take: limit,
    });
    res.json(events);
});

app.get("/vaults/:address/events", async (req, res) => {
    const events = await prisma.factoryEvent.findMany({
        where: { vault: req.params.address },
        orderBy: { ledger: "desc" },
    });
    res.json(events);
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => console.log(`YBC API running on :${PORT}`));
