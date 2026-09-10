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

async function applyMarketEvent(
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

    for (const raw of rawEvents) {
        highestLedger = Math.max(highestLedger, raw.ledger);
        const contractId = raw.contractId!.contractId();
        // One event this build cannot decode must not stop the indexer. It used
        // to: the throw escaped syncEvents before lastLedger was saved, so every
        // poll re-fetched the same events and failed on the same one, forever,
        // while systemd still reported the service healthy. A contract can add
        // an event at any time, so treat that as routine and keep going.
        // Skipping loses that one event; halting loses all of them.
        try {
            if (contractId === FACTORY_ADDRESS) {
                await applyFactoryEvent(raw, decodeFactoryEvent(raw));
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
    }

    await prisma.indexerState.update({
        where: { id: 1 },
        data: {
            lastPolled: new Date(),
            lastLedger: highestLedger,
        },
    });
}
