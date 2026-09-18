import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeAMMEvent, decodeFactoryEvent, decodeYmEvent } from "./events";

// Every event topic each contract can emit, mirrored from ybc-contracts. An
// event missing here is one the indexer skips, and it did: deposit_asset and
// redeem_to_asset — the app's own Split, Combine and Redeem — were dropped for
// every wallet until this list existed. Add a topic here when a contract gains
// an event; the drift check below catches it when ybc-contracts is checked out.
const EMITTED = {
    ym: [
        "token_contracts_set",
        "pool_set",
        "deposit",
        "redeem_combined",
        "redeem_principal",
        "distribute_yield",
        "flash_deposit",
        "flash_redeem",
        "surplus_collected",
        "deposit_asset",
        "redeem_to_asset",
    ],
    amm: [
        "pool_init",
        "swap_v_for_pt",
        "swap_pt_for_v",
        "flash_swap_pt",
        "flash_swap_v",
        "deposit",
        "withdraw",
        "reserve_fee_paid",
    ],
    factory: ["market_created", "wasm_hashes_updated", "fee_config_updated", "contract_upgraded"],
};

const DECODERS = { ym: decodeYmEvent, amm: decodeAMMEvent, factory: decodeFactoryEvent };

function eventNamed(topic: string): rpc.Api.EventResponse {
    const addr = () => nativeToScVal(Keypair.random().publicKey(), { type: "address" });
    return {
        id: "0000000100000000-0000000000",
        type: "contract",
        ledger: 100,
        ledgerClosedAt: new Date().toISOString(),
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        txHash: "deadbeef",
        topic: [nativeToScVal(topic, { type: "symbol" }), addr(), addr()],
        value: nativeToScVal([1n, 2n, 3n, 4n, 5n, 6n, 7n], { type: "i128" }),
    } as rpc.Api.EventResponse;
}

describe("every event a contract emits is decodable", () => {
    for (const [contract, topics] of Object.entries(EMITTED)) {
        const decode = DECODERS[contract as keyof typeof DECODERS];
        it.each(topics)(`${contract}: %s`, (topic) => {
            expect(() => decode(eventNamed(topic))).not.toThrow();
        });
    }
});

// ── drift check against the contract source ────────────────────────────────

const CONTRACTS = resolve(__dirname, "../../ybc-contracts/contracts");
const SOURCES = {
    ym: "yield/yield_manager/src/events.rs",
    amm: "amm/amm/src/events.rs",
    factory: "factory/src/events.rs",
};

// #[contractevent(topics = ["x"])] names the topic outright; a bare
// #[contractevent] takes the struct name in snake_case.
function topicsIn(source: string): string[] {
    const found: string[] = [];
    const re = /#\[contractevent(?:\(([^)]*)\))?\]\s*pub struct (\w+)/g;
    for (const [, args, struct] of source.matchAll(re)) {
        const explicit = args?.match(/topics\s*=\s*\[\s*"([^"]+)"/)?.[1];
        found.push(explicit ?? struct.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase());
    }
    return found;
}

describe.skipIf(!existsSync(CONTRACTS))("EMITTED matches ybc-contracts (needs ../ybc-contracts)", () => {
    for (const [contract, path] of Object.entries(SOURCES)) {
        it(`${contract} topics`, () => {
            const inSource = topicsIn(readFileSync(resolve(CONTRACTS, path), "utf8"));
            expect(inSource.length).toBeGreaterThan(0);
            expect([...inSource].sort()).toEqual([...EMITTED[contract as keyof typeof EMITTED]].sort());
        });
    }
});
