import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { decodeFactoryEvent, decodeAMMEvent, Market } from "./events";
import { describe, it, expect } from "vitest";

function addr(): string {
    return Keypair.random().publicKey();
}

type ScValTypeSpec = any;

const marketTypeSpec: ScValTypeSpec = {
    ym: ["symbol", "address"],
    pt: ["symbol", "address"],
    yt: ["symbol", "address"],
    pool: ["symbol", "address"],
    maturity: ["symbol", "u64"],
    vault: ["symbol", "address"],
};

function marketScVal(market: Market) {
    return nativeToScVal(market, { type: marketTypeSpec });
}

function fixtureEvent(
    topic: ReturnType<typeof nativeToScVal>[],
    value: ReturnType<typeof nativeToScVal>,
): rpc.Api.EventResponse {
    return {
        id: "0000000100000000-0000000000",
        type: "contract",
        ledger: 100,
        ledgerClosedAt: new Date().toISOString(),
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        txHash: "deadbeef",
        topic,
        value,
    } as rpc.Api.EventResponse;
}

describe("decodeFactoryEvent", () => {
    it("decodes market_created", () => {
        const creator = addr();
        const vault = addr();
        const market: Market = {
            name: "Test Market",
            ym: addr(),
            pt: addr(),
            yt: addr(),
            pool: addr(),
            maturity: 1234567890n,
            vault,
        };

        const event = fixtureEvent(
            [
                nativeToScVal("market_created", {
                    type: "symbol",
                }),
                nativeToScVal(creator, { type: "address" }),
                nativeToScVal(vault, { type: "address" }),
            ],
            marketScVal(market),
        );

        expect(decodeFactoryEvent(event)).toEqual({
            kind: "market_created",
            creator,
            vault,
            market,
        });
    });

    it("throws on pre-upgrade market_created layout (missing creator topic)", () => {
        const vault = addr();
        const market: Market = {
            name: "Test Market",
            ym: addr(),
            pt: addr(),
            yt: addr(),
            pool: addr(),
            maturity: 1234567890n,
            vault,
        };

        const event = fixtureEvent(
            [
                nativeToScVal("market_created", { type: "symbol" }),
                nativeToScVal(vault, { type: "address" }),
            ],
            marketScVal(market),
        );

        expect(() => decodeFactoryEvent(event)).toThrow(
            /pre-upgrade event layout is not supported/,
        );
    });

    it("decodes admin_changed", () => {
        const oldAdmin = addr();
        const newAdmin = addr();

        const event = fixtureEvent(
            [nativeToScVal("admin_changed", { type: "symbol" })],
            nativeToScVal(
                { old_admin: oldAdmin, new_admin: newAdmin },
                {
                    type: {
                        old_admin: ["symbol", "address"],
                        new_admin: ["symbol", "address"],
                    },
                },
            ),
        );

        expect(decodeFactoryEvent(event)).toEqual({
            kind: "admin_changed",
            oldAdmin,
            newAdmin,
        });
    });

    it("decodes wasm_hashes_updated", () => {
        const hashSpec: ScValTypeSpec = {
            pt: ["symbol", "bytes"],
            yt: ["symbol", "bytes"],
            ym: ["symbol", "bytes"],
            amm: ["symbol", "bytes"],
        };
        const oldHashes = {
            pt: Buffer.alloc(32, 1),
            yt: Buffer.alloc(32, 1),
            ym: Buffer.alloc(32, 1),
            amm: Buffer.alloc(32, 1),
        };
        const newHashes = {
            pt: Buffer.alloc(32, 2),
            yt: Buffer.alloc(32, 2),
            ym: Buffer.alloc(32, 2),
            amm: Buffer.alloc(32, 2),
        };

        const event = fixtureEvent(
            [nativeToScVal("wasm_hashes_updated", { type: "symbol" })],
            nativeToScVal(
                { old_hashes: oldHashes, new_hashes: newHashes },
                {
                    type: {
                        old_hashes: ["symbol", hashSpec],
                        new_hashes: ["symbol", hashSpec],
                    },
                },
            ),
        );
        const decoded = decodeFactoryEvent(event);
        expect(decoded.kind).toBe("wasm_hashes_updated");
    });

    it("decodes contract_upgraded", () => {
        const newWasmHash = Buffer.alloc(32, 3);

        const event = fixtureEvent(
            [nativeToScVal("contract_upgraded", { type: "symbol" })],
            nativeToScVal(
                { new_wasm_hash: newWasmHash },
                { type: { new_Wasm_hash: ["symbol", "bytes"] } },
            ),
        );

        const decoded = decodeFactoryEvent(event);
        expect(decoded.kind).toBe("contract_upgraded");
    });

    it("throws an unrecognized event name", () => {
        const event = fixtureEvent(
            [nativeToScVal("something_else", { type: "symbol" })],
            nativeToScVal({}),
        );

        expect(() => decodeFactoryEvent(event)).toThrow(
            /Unknown factory event/,
        );
    });
});

describe("decodeAMMEvent", () => {
    const poolInitTypeSpec: ScValTypeSpec = {
        expiry_ts: ["symbol", "u64"],
        current_apy: ["symbol", "i128"],
        apy_min: ["symbol", "i128"],
        apy_max: ["symbol", "i128"],
        fee_apy: ["symbol", "i128"],
        scalar_root: ["symbol", "i128"],
        fee_rate_root: ["symbol", "i128"],
        last_implied_rate: ["symbol", "i128"],
    };

    it("decodes pool_init", () => {
        const tokenA = addr();
        const tokenB = addr();
        const val = {
            expiry_ts: 1234567890n,
            current_apy: 500_000n,
            apy_min: 0n,
            apy_max: 10_000_000n,
            fee_apy: 100_000n,
            scalar_root: 123n,
            fee_rate_root: 456n,
            last_implied_rate: 789n,
        };

        const event = fixtureEvent(
            [
                nativeToScVal("pool_init", { type: "symbol" }),
                nativeToScVal(tokenA, { type: "address" }),
                nativeToScVal(tokenB, { type: "address" }),
            ],
            nativeToScVal(val, { type: poolInitTypeSpec }),
        );

        expect(decodeAMMEvent(event)).toEqual({
            kind: "pool_init",
            token_a: tokenA,
            token_b: tokenB,
            ...val,
        });
    });

    it("throws on pre-upgrade pool_init layout (missing apy fields)", () => {
        const tokenA = addr();
        const tokenB = addr();
        const legacyTypeSpec: ScValTypeSpec = {
            expiry_ts: ["symbol", "u64"],
            scalar_root: ["symbol", "i128"],
            initial_anchor: ["symbol", "i128"],
            fee_rate_root: ["symbol", "i128"],
            last_implied_rate: ["symbol", "i128"],
        };

        const event = fixtureEvent(
            [
                nativeToScVal("pool_init", { type: "symbol" }),
                nativeToScVal(tokenA, { type: "address" }),
                nativeToScVal(tokenB, { type: "address" }),
            ],
            nativeToScVal(
                {
                    expiry_ts: 1234567890n,
                    scalar_root: 123n,
                    initial_anchor: 456n,
                    fee_rate_root: 789n,
                    last_implied_rate: 111n,
                },
                { type: legacyTypeSpec },
            ),
        );

        expect(() => decodeAMMEvent(event)).toThrow(
            /pre-upgrade event layout is not supported/,
        );
    });
});
