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

const server = new rpc.Server(process.env.SOROBAN_RPC_URL!);
const PAGE_LIMIT = 1000;

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

export async function getEventsFor(
    contractIds: string[],
    startLedger: number,
): Promise<rpc.Api.EventResponse[]> {
    const events: rpc.Api.EventResponse[] = [];
    if (contractIds.length === 0) return events;

    const chunks: string[][] = [];
    for (let i = 0; i < contractIds.length; i += 5) {
        chunks.push(contractIds.slice(i, i + 5));
    }

    for (const chunk of chunks) {
        let response = await server.getEvents({
            filters: [{ type: "contract", contractIds: chunk }],
            startLedger,
            limit: PAGE_LIMIT,
        });
        events.push(...response.events);
        while (response.events.length === PAGE_LIMIT) {
            response = await server.getEvents({
                filters: [{ type: "contract", contractIds: chunk }],
                cursor: response.cursor,
                limit: PAGE_LIMIT,
            });
            events.push(...response.events);
        }
    }
    return events;
}
