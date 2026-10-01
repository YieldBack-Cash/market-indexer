import "dotenv/config";
import { PrismaClient, Prisma } from "@prisma/client";
import type { rpc } from "@stellar/stellar-sdk";
import {
    DecodedFactoryEvent,
    decodeFactoryEvent,
    DecodedRouterEvent,
    DecodedYmEvent,
    decodeRouterEvent,
    decodeYmEvent,
    DecodedAMMEvent,
    decodeAMMEvent,
} from "./events";
import {
    fetchEvents,
    getChainHealth,
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
import { alreadyApplied, UNDECODED, undecodedPayload } from "./undecoded";
import { marketNameFor, MAX_NAME_CHARS, MAX_SYMBOL_CHARS, retentionGap, sanitizeLabel } from "./cursor";

const prisma = new PrismaClient();
// Read per sync, not at module load, so a `.env` edit takes effect on the next
// poll of a long-running process rather than needing a restart to be noticed.
const factoryAddress = (): string => {
    const address = process.env.FACTORY_CONTRACT_ADDRESS;
    if (!address) throw new Error("FACTORY_CONTRACT_ADDRESS is not set");
    return address;
};
// The router is optional: without it the history is rebuilt from the yield
// manager's and pool's events alone, as it was before the router was indexed.
const routerAddress = (): string | null => process.env.ROUTER_CONTRACT_ADDRESS || null;

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
        // Strings the vault chose are sanitised on the way in (O-7): they are
        // shown to the curator and served by the API, and nothing on chain
        // bounds their content or length.
        const underlying = await getVaultUnderlying(decoded.vault);
        const shortVault = decoded.vault.slice(0, 8);
        vaultSymbol = sanitizeLabel(
            underlying?.symbol ?? (await getTokenSymbol(decoded.vault)),
            MAX_SYMBOL_CHARS,
            shortVault,
        );
        vaultMeta = {
            underlyingSymbol:
                underlying === undefined ? undefined : sanitizeLabel(underlying.symbol, MAX_SYMBOL_CHARS, shortVault),
            underlyingAsset: underlying?.assetAddress,
            pool: await getVaultPool(decoded.vault),
        };
    }
    await prisma.$transaction(async (tx) => {
        const existing = await tx.factoryEvent.findUnique({ where: { id: raw.id } });
        if (await alreadyApplied(existing, () => tx.factoryEvent.delete({ where: { id: raw.id } }))) return;

        switch (decoded.kind) {
            case "market_created": {
                // The factory names the market itself (`bvXLM-23DEC2026`); the
                // fallback only serves factories from before the name existed.
                // Sanitised too: the factory builds the name from the vault's
                // own symbol, so it is as much the vault's choice as the symbol.
                const marketName = sanitizeLabel(
                    marketNameFor(decoded.market, decoded.vault, vaultSymbol),
                    MAX_NAME_CHARS,
                    `${decoded.vault.slice(0, 8)}-${decoded.market.maturity}`,
                );
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
            case "ownership_transfer":
            case "ownership_transfer_completed":
            case "ownership_renounced":
            case "wasm_hashes_updated":
            case "contract_upgraded":
            case "fee_config_updated":
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

/** Which contract a market event came from; the `MarketEvent.source` column. */
export type EventSource = "ym" | "amm" | "router";

export async function applyMarketEvent(
    raw: rpc.Api.EventResponse,
    source: EventSource,
    decoded: DecodedYmEvent | DecodedAMMEvent | DecodedRouterEvent,
    marketId: string,
) {
    await prisma.$transaction(async (tx) => {
        const existing = await tx.marketEvent.findUnique({ where: { id: raw.id } });
        if (await alreadyApplied(existing, () => tx.marketEvent.delete({ where: { id: raw.id } }))) return;

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

/**
 * Decode `raw`, or store it undecoded and return null. `into` is where a
 * market event belongs; null means the factory.
 */
async function decodeOrRecord<T>(
    raw: rpc.Api.EventResponse,
    decode: (raw: rpc.Api.EventResponse) => T,
    into: { source: EventSource; market: string } | null,
): Promise<T | null> {
    try {
        return decode(raw);
    } catch (err) {
        console.error(
            `[undecoded event] ledger ${raw.ledger} ${raw.contractId!.contractId()}: ${
                err instanceof Error ? err.message : String(err)
            } (stored raw)`,
        );
        await recordUndecoded(raw, err, into).catch((dbErr) =>
            console.error(`[undecoded event] could not store ${raw.id}: ${dbErr}`),
        );
        return null;
    }
}

export async function recordUndecoded(
    raw: rpc.Api.EventResponse,
    err: unknown,
    into: { source: EventSource; market: string } | null,
) {
    const common = {
        id: raw.id,
        ledger: raw.ledger,
        ledgerClosedAt: new Date(raw.ledgerClosedAt),
        type: UNDECODED,
        txHash: raw.txHash,
        payload: undecodedPayload(raw, err),
    };
    // skipDuplicates-style: a replay must not overwrite an event that has
    // since been decoded, and must not fail on one already stored raw
    if (into) {
        const existing = await prisma.marketEvent.findUnique({ where: { id: raw.id } });
        if (existing) return;
        await prisma.marketEvent.create({
            data: { ...common, source: into.source, contractId: raw.contractId!.contractId(), market: into.market },
        });
    } else {
        const existing = await prisma.factoryEvent.findUnique({ where: { id: raw.id } });
        if (existing) return;
        await prisma.factoryEvent.create({ data: { ...common, vault: null } });
    }
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
    const factory = factoryAddress();
    const router = routerAddress();
    const state = await prisma.indexerState.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
    });
    const health = await getChainHealth();

    // Nothing has closed since the last poll: don't ask the RPC for events.
    if (state.lastLedger && state.lastLedger >= health.latestLedger) {
        await prisma.indexerState.update({ where: { id: 1 }, data: { lastPolled: new Date() } });
        return;
    }

    // An empty START_LEDGER means "from the tip", like an unset one.
    const configuredStart = Number(process.env.START_LEDGER) || health.latestLedger;
    let startLedger = state.lastLedger ? state.lastLedger + 1 : configuredStart;

    // Fallen out of the RPC's retention window: whatever happened between the
    // cursor and the oldest retained ledger cannot be fetched from this RPC.
    // Jump to what is available and say so, rather than asking forever for a
    // range the RPC no longer has (the 2026-09-09 failure mode).
    const gap = retentionGap(startLedger, health.oldestLedger);
    if (gap > 0) {
        console.error(
            `[retention] cursor ${startLedger} is ${gap} ledger(s) older than the RPC's oldest ` +
                `ledger ${health.oldestLedger}; events in that range are unrecoverable from this RPC. ` +
                `Resuming from ${health.oldestLedger}.`,
        );
        startLedger = health.oldestLedger;
    }

    const markets = await prisma.market.findMany({
        select: { id: true, ym: true, pool: true },
    });
    const ymToMarket = new Map(markets.map((market) => [market.ym, market.id]));
    const poolToMarket = new Map(
        markets.map((market) => [market.pool, market.id]),
    );

    const marketIds = new Set(markets.map((market) => market.id));

    const contractIds = [
        factory,
        ...(router ? [router] : []),
        ...ymToMarket.keys(),
        ...poolToMarket.keys(),
    ];
    const batch = await fetchEvents(contractIds, startLedger);
    const rawEvents = batch.events;
    // Ledger order, then emission order within a ledger: ids are fixed-width
    // TOIDs, so a plain string compare gives the order the chain emitted them.
    // That way a market's creation is applied before a router event that names
    // it in the same ledger.
    rawEvents.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));

    console.log(
        `[${new Date().toISOString()}] Fetched ${rawEvents.length} event(s) from ledger ${startLedger}` +
            ` to ${batch.scannedTo} (tip ${batch.latestLedger})`,
    );

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
        // Skipping loses that one event; halting loses all of them. So an event
        // that won't decode is kept raw (see recordUndecoded) and the loop moves
        // on; a failure applying a decoded one is transient and only logged.
        try {
            if (contractId === factory) {
                const decoded = await decodeOrRecord(raw, decodeFactoryEvent, null);
                if (!decoded) return;
                await applyFactoryEvent(raw, decoded);
                if (decoded.kind === "market_created") {
                    const id = `${decoded.vault}:${decoded.market.maturity}`;
                    created.push({
                        ym: decoded.market.ym,
                        pool: decoded.market.pool,
                        id,
                        ledger: raw.ledger,
                    });
                    // Router events later in this same batch may name it.
                    marketIds.add(id);
                }
            } else if (ymToMarket.has(contractId)) {
                const market = ymToMarket.get(contractId)!;
                const decoded = await decodeOrRecord(raw, decodeYmEvent, { source: "ym", market });
                if (decoded) await applyMarketEvent(raw, "ym", decoded, market);
            } else if (poolToMarket.has(contractId)) {
                const market = poolToMarket.get(contractId)!;
                const decoded = await decodeOrRecord(raw, decodeAMMEvent, { source: "amm", market });
                if (decoded) await applyMarketEvent(raw, "amm", decoded, market);
            } else if (router && contractId === router) {
                // A router event names its market itself. One for a market this
                // indexer doesn't know (created after this sync's market list was
                // read, or on another factory) is skipped; the next sync's list
                // will know it, and the cursor only advances past applied events
                // once the whole batch is done.
                const decoded = await decodeOrRecord(raw, decodeRouterEvent, null);
                if (!decoded) return;
                const market = `${decoded.vault}:${decoded.maturity}`;
                if (!marketIds.has(market)) {
                    console.warn(`[router event] ${decoded.kind} for unknown market ${market}; skipped`);
                    return;
                }
                await applyMarketEvent(raw, "router", decoded, market);
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
        catchUp.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
        // This fetch may reach past `batch.scannedTo`; anything beyond it is
        // fetched again next poll and deduped by event id, so the cursor below
        // is still only advanced to what the main batch covered for every
        // watched contract.
        for (const raw of catchUp) {
            await applyRaw(raw);
        }
    }

    // The cursor is the last ledger the RPC scanned for us, not the last event
    // seen: a quiet poll therefore lands at the tip instead of creeping one
    // ledger forward and re-reading the same span every five seconds.
    await prisma.indexerState.update({
        where: { id: 1 },
        data: {
            lastPolled: new Date(),
            lastLedger: batch.scannedTo,
        },
    });
}
