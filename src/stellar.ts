import { SCALAR_7, SCALE } from "./protocol/protocol";
import "dotenv/config";
import {
    rpc,
    TransactionBuilder,
    Networks,
    Account,
    Contract,
    xdr,
    scValToNative,
    nativeToScVal,
    Keypair,
} from "@stellar/stellar-sdk";

const PAGE_LIMIT = 1000;

// Built on first use, not at import: unit tests import this module without an
// RPC URL, and a missing one should fail the call that needs it, not the import.
let serverInstance: rpc.Server | undefined;
function rpcServer(): rpc.Server {
    if (!serverInstance) {
        const url = process.env.SOROBAN_RPC_URL;
        if (!url) throw new Error("SOROBAN_RPC_URL is not set");
        serverInstance = new rpc.Server(url);
    }
    return serverInstance;
}
const server: EventClient & Pick<rpc.Server, "simulateTransaction" | "getLatestLedger" | "getHealth"> = {
    getEvents: (request) => rpcServer().getEvents(request),
    simulateTransaction: (tx) => rpcServer().simulateTransaction(tx),
    getLatestLedger: () => rpcServer().getLatestLedger(),
    getHealth: () => rpcServer().getHealth(),
};

/**
 * The one way the indexer reads a contract: simulate a call and decode the
 * result. Throws with the simulation's own error text when it fails.
 */
async function read<T>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
    const account = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
    })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(30)
        .build();
    const result = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(result)) throw new Error(result.error);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result) throw new Error(`${method} returned no value`);
    return scValToNative(result.result.retval) as T;
}

/** `read`, or undefined when the contract lacks the method or the read fails. */
async function tryRead<T>(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T | undefined> {
    try {
        return await read<T>(contractId, method, args);
    } catch {
        return undefined;
    }
}

export async function getTokenSymbol(contractId: string): Promise<string> {
    return (await tryRead<string>(contractId, "symbol")) ?? contractId.slice(0, 8);
}

export type VaultUnderlying = { assetAddress: string; symbol: string };

// SEP-56 vaults (the interface YBC integrates with) expose `query_asset`; some
// older vaults expose `asset`. Try the standard name first so both keep working.
export async function getVaultUnderlying(
    vaultContractId: string,
): Promise<VaultUnderlying | undefined> {
    const assetAddress =
        (await tryRead<string>(vaultContractId, "query_asset")) ??
        (await tryRead<string>(vaultContractId, "asset"));
    if (!assetAddress) return undefined;

    const symbol = await getTokenSymbol(assetAddress);
    return { assetAddress, symbol: symbol === "native" ? "XLM" : symbol };
}

// The protocol contract the vault supplies to (Blend pool, XOXNO controller),
// from the YBC adapters' informational `get_protocol() -> Address`. It is not
// part of SEP-56, so a third-party vault simply has no pool recorded.
export async function getVaultPool(vaultContractId: string): Promise<string | undefined> {
    return tryRead<string>(vaultContractId, "get_protocol");
}

export async function getPoolReserveFeeRate(poolContractId: string): Promise<bigint | undefined> {
    return tryRead<bigint>(poolContractId, "get_reserve_fee_rate");
}

/** Assets per vault share, as a number, or undefined when the vault won't answer. */
export async function getVaultExchangeRate(vaultContractId: string): Promise<number | undefined> {
    const assets = await tryRead<bigint>(vaultContractId, "convert_to_assets", [
        nativeToScVal(SCALAR_7, { type: "i128" }),
    ]);
    return assets === undefined ? undefined : Number(assets) / SCALE;
}

export async function getTokenBalance(contractId: string, accountId: string): Promise<bigint | undefined> {
    return tryRead<bigint>(contractId, "balance", [nativeToScVal(accountId, { type: "address" })]);
}

export async function getCurrentLedger(): Promise<number> {
    const latest = await server.getLatestLedger();
    return latest.sequence;
}

// ── chain position ──────────────────────────────────────────────────────────

export interface ChainHealth {
    /** The newest ledger the RPC has. */
    latestLedger: number;
    /** The oldest ledger the RPC still holds events for; anything older is gone. */
    oldestLedger: number;
}

const HEALTH_TTL_MS = 2_000;
let healthCache: { at: number; value: ChainHealth } | undefined;

/**
 * Where the RPC's window of history starts and ends. One cheap call, cached
 * briefly because the poller and the API both ask on their own schedules.
 */
export async function getChainHealth(): Promise<ChainHealth> {
    if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
    const health = await server.getHealth();
    const value = { latestLedger: health.latestLedger, oldestLedger: health.oldestLedger };
    healthCache = { at: Date.now(), value };
    return value;
}

// ── events ──────────────────────────────────────────────────────────────────

/** The subset of `rpc.Server` the event fetcher uses; injectable for tests. */
export interface EventClient {
    getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

export interface EventBatch {
    events: rpc.Api.EventResponse[];
    /**
     * The last ledger the RPC scanned on our behalf. Every event in
     * [startLedger, scannedTo] from the requested contracts is in `events`,
     * so this is what the cursor should advance to.
     */
    scannedTo: number;
    /** The chain tip as the RPC saw it while answering. */
    latestLedger: number;
}

// The RPC's own limits on one getEvents request.
const IDS_PER_FILTER = 5;
const FILTERS_PER_REQUEST = 5;

/**
 * The ledger a pagination cursor points at. Cursors are TOIDs, "<ledger << 32 |
 * tx << 12 | op>-<event index>", and the ledger is the upper 32 bits.
 */
export function cursorLedger(cursor: string): number | undefined {
    const digits = cursor.split("-")[0];
    if (!/^[0-9]+$/.test(digits)) return undefined;
    return Number(BigInt(digits) >> 32n);
}

/**
 * Every event from `contractIds` between `startLedger` and the chain tip.
 *
 * Two RPC behaviours shape this. A request scans at most ~10,000 ledgers and
 * then returns a cursor for continuing, even when it found few or no events, so
 * a single request from an old cursor silently misses everything past that
 * horizon; the loop keeps following the cursor until the scan reaches the tip
 * the RPC reported. And a request takes up to five filters of five contracts,
 * so 25 contracts travel in one request rather than five.
 */
export async function fetchEvents(
    contractIds: string[],
    startLedger: number,
    client: EventClient = server,
): Promise<EventBatch> {
    const events: rpc.Api.EventResponse[] = [];
    let scannedTo = Number.POSITIVE_INFINITY;
    let latestLedger = 0;

    const filters: rpc.Server.GetEventsRequest["filters"] = [];
    for (let i = 0; i < contractIds.length; i += IDS_PER_FILTER) {
        filters.push({ type: "contract", contractIds: contractIds.slice(i, i + IDS_PER_FILTER) });
    }
    if (filters.length === 0) {
        const health = await getChainHealth();
        return { events, scannedTo: health.latestLedger, latestLedger: health.latestLedger };
    }

    for (let i = 0; i < filters.length; i += FILTERS_PER_REQUEST) {
        const group = filters.slice(i, i + FILTERS_PER_REQUEST);
        let response = await client.getEvents({ filters: group, startLedger, limit: PAGE_LIMIT });
        events.push(...response.events);
        let reached = reachedLedger(response, startLedger);

        // Keep going while the RPC stopped short of its own tip, whether
        // because a page filled up or because the scan window ran out.
        while (response.events.length === PAGE_LIMIT || reached < response.latestLedger) {
            const before = reached;
            response = await client.getEvents({ filters: group, cursor: response.cursor, limit: PAGE_LIMIT });
            events.push(...response.events);
            reached = reachedLedger(response, reached);
            // An RPC that hands back the same cursor twice would otherwise pin
            // this loop; treat the scan as finished where it stands.
            if (reached === before && response.events.length < PAGE_LIMIT) break;
        }
        // Normally the scan ends at the tip; if it was cut short, only claim
        // what was actually covered so the next poll resumes from there.
        scannedTo = Math.min(scannedTo, reached, response.latestLedger);
        latestLedger = Math.max(latestLedger, response.latestLedger);
    }

    return { events, scannedTo, latestLedger };
}

/** How far a response's scan got, from its cursor; never less than `floor`. */
function reachedLedger(response: rpc.Api.GetEventsResponse, floor: number): number {
    const fromCursor = cursorLedger(response.cursor ?? "");
    const fromEvents = response.events.reduce((max, e) => Math.max(max, e.ledger), 0);
    // A cursor that cannot be parsed would loop forever if treated as "not
    // there yet", so fall back to trusting the tip in that case.
    if (fromCursor === undefined) return response.latestLedger;
    return Math.max(floor, fromCursor, fromEvents);
}

/** `fetchEvents` for callers that only want the events. */
export async function getEventsFor(
    contractIds: string[],
    startLedger: number,
): Promise<rpc.Api.EventResponse[]> {
    return (await fetchEvents(contractIds, startLedger)).events;
}
