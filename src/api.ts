import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient, Market } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { getTokenBalance } from "./stellar";

const app = express();
// Behind nginx, req.ip is the proxy's address unless we trust one hop — without
// this the rate limiter buckets every client together.
app.set("trust proxy", 1);
app.use(
    cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000" }),
);
app.use(rateLimit({ windowMs: 60_000, max: 60 }));
const prisma = new PrismaClient();

// Evaluated per request so `isActive` reflects the current time, not server
// boot time.
function nowSecs(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
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

    return {
        ...serialized,
        isActive: market.maturity > now,
    };
}

app.get("/markets", async (req, res) => {
    const now = nowSecs();
    const markets = await prisma.market.findMany({
        where: { maturity: { gt: now } },
        orderBy: { maturity: "asc" },
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
        where: { vault: req.params.address },
        orderBy: { maturity: "asc" },
    });

    res.json(markets.map((m) => toMarketJson(m, now)));
});

app.get("/accounts/:address/balances", async (req, res) => {
    const now = nowSecs();
    const markets = await prisma.market.findMany({
        where: {
            maturity: {
                gt: now
            }
        },
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
        include: { markets: true },
    });

    res.json(
        vaults.map((vault) => ({
            ...vault,
            markets: vault.markets.map((m) => toMarketJson(m, now)),
        })),
    );
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
