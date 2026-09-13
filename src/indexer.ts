import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import type { rpc } from "@stellar/stellar-sdk";
import {
    DecodedFactoryEvent,
    decodeFactoryEvent,
    DecodedYmEvent,
    decodeYmEvent,
    DecodedAMMEvent,
    decodeAMMEvent,
} from "./events";
import {
    getCurrentLedger,
    getEventsFor,
    getTokenSymbol,
    getVaultUnderlying,
    getVaultPool,
    getVaultExchangeRate,
} from "./stellar";
import {
    APY_WINDOW_MS,
    computeLpFeeApy,
    FeeTrade,
    RESERVE_KINDS,
    TRADE_KINDS,
} from "./fees";

const prisma = new PrismaClient();
const FACTORY_ADDRESS = process.env.FACTORY_CONTRACT_ADDRESS!;

function toJsonSafe(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(
        JSON.stringify(value, (_key, v) =>
            typeof v === "bigint" ? v.toString() : v,
        ),
    );
}

async function applyFactoryEvent(
    raw: rpc.Api.EventResponse,
    decoded: DecodedFactoryEvent,
) {
    // Resolved outside the transaction: these are network round-trips, and all
    // of them are best-effort — a vault that answers nothing must still index.
    let vaultSymbol: string | undefined;
    let vaultMeta: {
        underlyingSymbol?: string;
        underlyingAsset?: string;
        pool?: string;
    } = {};
    if (decoded.kind === "market_created") {
        const underlying = await getVaultUnderlying(decoded.vault);
        vaultSymbol =
            underlying?.symbol ?? (await getTokenSymbol(decoded.vault));
        vaultMeta = {
            underlyingSymbol: underlying?.symbol,
            underlyingAsset: underlying?.assetAddress,
            pool: await getVaultPool(decoded.vault),
        };
    }
    await prisma.$transaction(async (tx) => {
        const alreadyProcessed = await tx.factoryEvent.findUnique({
            where: { id: raw.id },
        });
        if (alreadyProcessed) return;

        switch (decoded.kind) {
            case "market_created": {
                const maturityDate = new Date(
                    Number(decoded.market.maturity) * 1000,
                )
                    .toISOString()
                    .slice(0, 10);
                const marketName = `${vaultSymbol ?? decoded.vault.slice(0, 8)}-${maturityDate}`;
                // Written on update too, so a vault indexed before these
                // columns existed gets backfilled on its next market.
                await tx.vault.upsert({
                    where: { address: decoded.vault },
                    update: vaultMeta,
                    create: { address: decoded.vault, ...vaultMeta },
                });
                await tx.market.create({
                    data: {
                        id: `${decoded.vault}:${decoded.market.maturity}`,
                        vault: decoded.vault,
                        name: marketName,
                        ym: decoded.market.ym,
                        pt: decoded.market.pt,
                        yt: decoded.market.yt,
                        pool: decoded.market.pool,
                        maturity: decoded.market.maturity,
                    },
                });
                break;
            }
            case "admin_changed":
            case "wasm_hashes_updated":
            case "contract_upgraded":
                break;
        }

        await tx.factoryEvent.create({
            data: {
                id: raw.id,
                ledger: raw.ledger,
                ledgerClosedAt: new Date(raw.ledgerClosedAt),
                type: decoded.kind,
                txHash: raw.txHash,
                vault: "vault" in decoded ? decoded.vault : null,
                payload: toJsonSafe(decoded),
            },
        });
    });
}

export async function applyMarketEvent(
    raw: rpc.Api.EventResponse,
    source: "ym" | "amm",
    decoded: DecodedYmEvent | DecodedAMMEvent,
    marketId: string,
) {
    await prisma.$transaction(async (tx) => {
        const alreadyProcessed = await tx.marketEvent.findUnique({
            where: { id: raw.id },
        });
        if (alreadyProcessed) return;

        await tx.marketEvent.create({
            data: {
                id: raw.id,
                ledger: raw.ledger,
                ledgerClosedAt: new Date(raw.ledgerClosedAt),
                source,
                type: decoded.kind,
                txHash: raw.txHash,
                contractId: raw.contractId!.contractId(),
                market: marketId,
                payload: toJsonSafe(decoded),
            },
        });

        // The pool's creation params are only ever emitted here, once.
        if (decoded.kind === "pool_init") {
            await tx.market.update({
                where: { id: marketId },
                data: {
                    currentApy: decoded.current_apy,
                    apyMin: decoded.apy_min,
                    apyMax: decoded.apy_max,
                    feeApy: decoded.fee_apy,
                    reserveFeeRate: decoded.reserve_fee_rate,
                },
            });
        }
    });
}

export async function snapshotVaultRates() {
    const vaults = await prisma.vault.findMany({ select: { address: true } });

    for (const vault of vaults) {
        const rate = await getVaultExchangeRate(vault.address);
        if (rate === undefined) continue;

        await prisma.vaultRateSnapshot.create({
            data: {
                vault: vault.address,
                rate,
            },
        });
    }

    console.log(
        `[${new Date().toISOString()}] Snapshotted rates for ${vaults.length} vault(s)`,
    );
}

// Payload bigints were stored as strings by toJsonSafe.
function payloadBigInt(payload: Prisma.JsonValue, key: string): bigint | undefined {
    const value = (payload as Record<string, unknown> | null)?.[key];
    return typeof value === "string" ? BigInt(value) : undefined;
}

function toFeeTrade(event: { ledgerClosedAt: Date; payload: Prisma.JsonValue }): FeeTrade {
    return {
        at: event.ledgerClosedAt,
        fee: payloadBigInt(event.payload, "fee"),
        reserveFee: payloadBigInt(event.payload, "reserve_fee"),
    };
}

export async function updateLpFeeApys() {
    const now = new Date();
    const markets = await prisma.market.findMany({
        select: { id: true, vault: true, maturity: true },
    });
    const tradeKinds = [...TRADE_KINDS];

    for (const market of markets) {
        const ammEvents = { market: market.id, source: "amm" };
        const select = { ledgerClosedAt: true, payload: true };

        const [firstTrade, windowTrades, latestReserves, latestTrade, poolInit, rate] =
            await Promise.all([
                prisma.marketEvent.findFirst({
                    where: { ...ammEvents, type: { in: tradeKinds } },
                    orderBy: { ledger: "asc" },
                    select,
                }),
                prisma.marketEvent.findMany({
                    where: {
                        ...ammEvents,
                        type: { in: tradeKinds },
                        ledgerClosedAt: { gte: new Date(now.getTime() - APY_WINDOW_MS) },
                    },
                    select,
                }),
                prisma.marketEvent.findFirst({
                    where: { ...ammEvents, type: { in: [...RESERVE_KINDS] } },
                    orderBy: { ledger: "desc" },
                    select,
                }),
                prisma.marketEvent.findFirst({
                    where: { ...ammEvents, type: { in: tradeKinds } },
                    orderBy: { ledger: "desc" },
                    select,
                }),
                prisma.marketEvent.findFirst({
                    where: { ...ammEvents, type: "pool_init" },
                    select,
                }),
                prisma.vaultRateSnapshot.findFirst({
                    where: { vault: market.vault },
                    orderBy: { timestamp: "desc" },
                }),
            ]);

        // Deposits and withdrawals don't move the implied rate, so it comes from
        // the latest trade, or the opening rate if the pool hasn't traded.
        const impliedRate =
            (latestTrade && payloadBigInt(latestTrade.payload, "new_implied_rate")) ??
            (poolInit && payloadBigInt(poolInit.payload, "last_implied_rate")) ??
            null;

        const lpFeeApy = computeLpFeeApy({
            now,
            maturity: market.maturity,
            firstTrade: firstTrade && toFeeTrade(firstTrade),
            windowTrades: windowTrades.map(toFeeTrade),
            reserveA: (latestReserves && payloadBigInt(latestReserves.payload, "new_reserve_a")) ?? null,
            reserveB: (latestReserves && payloadBigInt(latestReserves.payload, "new_reserve_b")) ?? null,
            impliedRate,
            vaultRate: rate?.rate ?? null,
        });

        await prisma.market.update({
            where: { id: market.id },
            data: { lpFeeApy, lpFeeApyUpdatedAt: now },
        });
    }

    console.log(
        `[${now.toISOString()}] Updated LP fee APY for ${markets.length} market(s)`,
    );
}

export async function syncEvents() {
    const state = await prisma.indexerState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
    });

    const startLedger = state.lastLedger
        ? state.lastLedger + 1
        : Number(process.env.START_LEDGER ?? (await getCurrentLedger()));

    const markets = await prisma.market.findMany({
        select: { id: true, ym: true, pool: true },
    });
    const ymToMarket = new Map(markets.map((market) => [market.ym, market.id]));
    const poolToMarket = new Map(
        markets.map((market) => [market.pool, market.id]),
    );

    const contractIds = [
        FACTORY_ADDRESS,
        ...ymToMarket.keys(),
        ...poolToMarket.keys(),
    ];
    const rawEvents = await getEventsFor(contractIds, startLedger);
    rawEvents.sort((a, b) => a.ledger - b.ledger);

    console.log(
        `[${new Date().toISOString()}] Fetched ${rawEvents.length} event(s) from ledger ${startLedger}`,
    );

    let highestLedger = startLedger;

    // A market's YM and pool emit their init events (pool_init carries the
    // market's APY/fee params) in the same ledger as market_created. They were
    // not in `contractIds` when this batch was fetched, and the next poll starts
    // after that ledger, so fetch them now from the creation ledger. Replaying
    // is safe: every apply is idempotent on the event id.
    const created: { ym: string; pool: string; id: string; ledger: number }[] =
        [];

    const applyRaw = async (raw: rpc.Api.EventResponse) => {
        const contractId = raw.contractId!.contractId();
        // One event this build cannot decode must not stop the indexer. It used
        // to: the throw escaped syncEvents before lastLedger was saved, so every
        // poll re-fetched the same events and failed on the same one, forever,
        // while systemd still reported the service healthy. A contract can add
        // an event at any time, so treat that as routine and keep going.
        // Skipping loses that one event; halting loses all of them.
        try {
            if (contractId === FACTORY_ADDRESS) {
                const decoded = decodeFactoryEvent(raw);
                await applyFactoryEvent(raw, decoded);
                if (decoded.kind === "market_created") {
                    created.push({
                        ym: decoded.market.ym,
                        pool: decoded.market.pool,
                        id: `${decoded.vault}:${decoded.market.maturity}`,
                        ledger: raw.ledger,
                    });
                }
            } else if (ymToMarket.has(contractId)) {
                await applyMarketEvent(
                    raw,
                    "ym",
                    decodeYmEvent(raw),
                    ymToMarket.get(contractId)!,
                );
            } else if (poolToMarket.has(contractId)) {
                await applyMarketEvent(
                    raw,
                    "amm",
                    decodeAMMEvent(raw),
                    poolToMarket.get(contractId)!,
                );
            }
        } catch (err) {
            console.error(
                `[skipped event] ledger ${raw.ledger} ${contractId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    };

    for (const raw of rawEvents) {
        highestLedger = Math.max(highestLedger, raw.ledger);
        await applyRaw(raw);
    }

    const newMarkets = created.filter((m) => !poolToMarket.has(m.pool));
    if (newMarkets.length > 0) {
        for (const m of newMarkets) {
            ymToMarket.set(m.ym, m.id);
            poolToMarket.set(m.pool, m.id);
        }
        const catchUp = await getEventsFor(
            newMarkets.flatMap((m) => [m.ym, m.pool]),
            Math.min(...newMarkets.map((m) => m.ledger)),
        );
        catchUp.sort((a, b) => a.ledger - b.ledger);
        // Deliberately leaves highestLedger alone: this fetch can reach past
        // the main batch, and advancing the cursor would skip other contracts'
        // events in that gap. Anything past it is re-fetched next poll and
        // deduped.
        for (const raw of catchUp) {
            await applyRaw(raw);
        }
    }

    await prisma.indexerState.update({
        where: { id: 1 },
        data: {
            lastPolled: new Date(),
            lastLedger: highestLedger,
        },
    });
}
