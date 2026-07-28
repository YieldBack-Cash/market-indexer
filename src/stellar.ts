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

export async function getTokenSymbol(contractId: string): Promise<string> {
    try {
        const account = new Account(Keypair.random().publicKey(), "0");
        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: Networks.TESTNET,
        })
            .addOperation(new Contract(contractId).call("symbol"))
            .setTimeout(30)
            .build();
        const result = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(result)) return contractId.slice(0, 8);

        return scValToNative(result.result!.retval) as string;
    } catch {
        return contractId.slice(0, 8);
    }
}

export async function getVaultUnderlyingSymbol(
    vaultContractId: string,
): Promise<string | undefined> {
    try {
        const account = new Account(Keypair.random().publicKey(), "0");
        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: Networks.TESTNET,
        })
            .addOperation(new Contract(vaultContractId).call("asset"))
            .setTimeout(30)
            .build();
        const result = await server.simulateTransaction(tx);

        if (rpc.Api.isSimulationError(result)) return undefined;

        const assetAddress = scValToNative(result.result!.retval) as string;
        const symbol = await getTokenSymbol(assetAddress);
        return symbol === "native" ? "XLM" : symbol;
    } catch {
        return undefined;
    }
}

export async function getVaultExchangeRate(
    vaultContractId: string,
): Promise<number | undefined> {
    try {
        const account = new Account(Keypair.random().publicKey(), "0");
        const tx = new TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: Networks.TESTNET,
        })
            .addOperation(
                new Contract(vaultContractId).call(
                    "convert_to_assets",
                    nativeToScVal(10_000_000, {
                        type: "i128",
                    }),
                ),
            )
            .setTimeout(30)
            .build();

        const result = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(result)) return undefined;

        const assets = scValToNative(result.result!.retval) as bigint;
        return Number(assets) / 1e7;
    } catch {
        return undefined;
    }
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
