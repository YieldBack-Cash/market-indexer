import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { decodeAMMEvent } from "./events";
import { applyMarketEvent } from "./indexer";
import { getEventsFor, getPoolReserveFeeRate } from "./stellar";

// One-off: fills the pool_init params (currentApy, apyMin, apyMax, feeApy,
// reserveFeeRate) for markets indexed before the indexer captured pool_init.
//
// For each market still missing them:
//   1. reserveFeeRate is read live from the pool (`get_reserve_fee_rate`).
//   2. pool_init is re-fetched from RPC starting at the market_created ledger,
//      and applied like a live event (so it's also recorded in MarketEvent).
//      Only works while that ledger is inside the RPC's retention window.
//   3. Anything still null comes from the deployments file, matched by pool.
// Never overwrites a value that is already set.

const prisma = new PrismaClient();

const USAGE = `Usage:
  npm run backfill-params -- <path to deployments.testnet.json>`;

type DeploymentMarket = {
    pool: string;
    current_apy: number;
    apy_min: number;
    apy_max: number;
    fee_apy: number;
};

async function refetchPoolInit(market: { id: string; pool: string }) {
    const created = await prisma.factoryEvent.findFirst({
        where: {
            type: "market_created",
            payload: { path: ["market", "pool"], equals: market.pool },
        },
        select: { ledger: true },
    });
    if (!created) return "no market_created event indexed";

    try {
        const events = await getEventsFor([market.pool], created.ledger);
        for (const raw of events) {
            const decoded = decodeAMMEvent(raw);
            if (decoded.kind !== "pool_init") continue;
            await applyMarketEvent(raw, "amm", decoded, market.id);
            return "pool_init from RPC";
        }
        return "pool_init not in RPC results";
    } catch (err) {
        return `RPC: ${err instanceof Error ? err.message : String(err)}`;
    }
}

async function main() {
    const [deploymentsPath] = process.argv.slice(2);
    if (!deploymentsPath) {
        console.error(USAGE);
        return 1;
    }
    const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8")) as {
        markets: DeploymentMarket[];
    };
    const byPool = new Map(deployments.markets.map((m) => [m.pool, m]));

    const markets = await prisma.market.findMany({
        where: {
            OR: [
                { currentApy: null },
                { apyMin: null },
                { apyMax: null },
                { feeApy: null },
                { reserveFeeRate: null },
            ],
        },
    });

    for (const market of markets) {
        const steps: string[] = [];

        if (market.reserveFeeRate === null) {
            const rate = await getPoolReserveFeeRate(market.pool);
            if (rate !== undefined) {
                await prisma.market.update({
                    where: { id: market.id },
                    data: { reserveFeeRate: rate },
                });
                steps.push("reserveFeeRate from chain");
            }
        }

        if (market.feeApy === null) {
            steps.push(await refetchPoolInit(market));
        }

        // Re-read: pool_init may have just filled some or all of them.
        const current = await prisma.market.findUniqueOrThrow({
            where: { id: market.id },
        });
        const fromFile = byPool.get(market.pool);
        if (fromFile) {
            const data: Record<string, bigint> = {};
            if (current.currentApy === null) data.currentApy = BigInt(fromFile.current_apy);
            if (current.apyMin === null) data.apyMin = BigInt(fromFile.apy_min);
            if (current.apyMax === null) data.apyMax = BigInt(fromFile.apy_max);
            if (current.feeApy === null) data.feeApy = BigInt(fromFile.fee_apy);
            if (Object.keys(data).length > 0) {
                await prisma.market.update({ where: { id: market.id }, data });
                steps.push(`${Object.keys(data).join(", ")} from deployments file`);
            }
        }

        const after = await prisma.market.findUniqueOrThrow({
            where: { id: market.id },
        });
        const stillNull = (
            ["currentApy", "apyMin", "apyMax", "feeApy", "reserveFeeRate"] as const
        ).filter((f) => after[f] === null);
        console.log(
            `  ${market.id} (${market.name})\n      ${steps.join("; ") || "nothing to do"}` +
                (stillNull.length > 0
                    ? `\n      still null: ${stillNull.join(", ")}`
                    : ""),
        );
    }
    console.log(`\n${markets.length} market(s) needed params`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
