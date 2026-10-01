import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { decodeAMMEvent, decodeFactoryEvent, decodeYmEvent, Market } from "./events";
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

        const creator = addr();
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

describe("decodeYmEvent", () => {
    const i128s = (values: bigint[]) => nativeToScVal(values, { type: "i128" });

    // field order is the contract struct's, yield_manager/src/events.rs
    it("decodes deposit_asset, the app's Split", () => {
        const from = addr();
        const event = fixtureEvent(
            [nativeToScVal("deposit_asset", { type: "symbol" }), nativeToScVal(from, { type: "address" })],
            i128s([200_000_000_000n, 97_556_543_23n, 199_999_996_13n, 20_500_931n]),
        );

        expect(decodeYmEvent(event)).toEqual({
            kind: "deposit_asset",
            from,
            asset_in: 200_000_000_000n,
            shares_in: 97_556_543_23n,
            mint_amount: 199_999_996_13n,
            exchange_rate: 20_500_931n,
        });
    });

    it("decodes redeem_to_asset, the app's Combine and Redeem", () => {
        const from = addr();
        const event = fixtureEvent(
            [nativeToScVal("redeem_to_asset", { type: "symbol" }), nativeToScVal(from, { type: "address" })],
            i128s([1_000_000_000n, 487_000_000n, 998_000_000n, 20_500_000n]),
        );

        expect(decodeYmEvent(event)).toEqual({
            kind: "redeem_to_asset",
            from,
            burned: 1_000_000_000n,
            shares_redeemed: 487_000_000n,
            asset_out: 998_000_000n,
            exchange_rate: 20_500_000n,
        });
    });

    it("still throws on a topic it doesn't know", () => {
        const event = fixtureEvent([nativeToScVal("something_new", { type: "symbol" })], i128s([1n]));
        expect(() => decodeYmEvent(event)).toThrow(/Unknown YM Event/);
    });
});

describe("decodeAMMEvent", () => {
    const i128s = (values: bigint[]) =>
        nativeToScVal(values, { type: "i128" });

    it("decodes pool_init with the creator params", () => {
        const tokenA = addr();
        const tokenB = addr();
        const treasury = addr();
        const fields = {
            expiry_ts: 1820448000n,
            current_apy: 1_000_000n,
            apy_min: 200_000n,
            apy_max: 2_000_000n,
            fee_apy: 100_000n,
            scalar_root: 243_024_958n,
            fee_rate_root: 99_503n,
            last_implied_rate: 953_102n,
            reserve_fee_rate: 1_000_000n,
        };
        const i128: ScValTypeSpec = ["symbol", "i128"];
        const event = fixtureEvent(
            [
                nativeToScVal("pool_init", { type: "symbol" }),
                nativeToScVal(tokenA, { type: "address" }),
                nativeToScVal(tokenB, { type: "address" }),
            ],
            nativeToScVal(
                { ...fields, treasury },
                {
                    type: {
                        expiry_ts: ["symbol", "u64"],
                        current_apy: i128,
                        apy_min: i128,
                        apy_max: i128,
                        fee_apy: i128,
                        scalar_root: i128,
                        fee_rate_root: i128,
                        last_implied_rate: i128,
                        reserve_fee_rate: i128,
                        treasury: ["symbol", "address"],
                    },
                },
            ),
        );

        expect(decodeAMMEvent(event)).toEqual({
            kind: "pool_init",
            token_a: tokenA,
            token_b: tokenB,
            ...fields,
            treasury,
        });
    });

    it("decodes a swap carrying fee and reserve_fee", () => {
        const to = addr();
        const event = fixtureEvent(
            [
                nativeToScVal("swap_pt_for_v", { type: "symbol" }),
                nativeToScVal(to, { type: "address" }),
            ],
            i128s([100n, 90n, 953_102n, 1100n, 910n, 5n, 1n]),
        );

        expect(decodeAMMEvent(event)).toEqual({
            kind: "swap_pt_for_v",
            to,
            pt_in: 100n,
            v_out: 90n,
            new_implied_rate: 953_102n,
            new_reserve_a: 1100n,
            new_reserve_b: 910n,
            fee: 5n,
            reserve_fee: 1n,
        });
    });

    it("decodes a swap from older wasm without the fee fields", () => {
        const receiver = addr();
        const user = addr();
        const event = fixtureEvent(
            [
                nativeToScVal("flash_swap_v", { type: "symbol" }),
                nativeToScVal(receiver, { type: "address" }),
                nativeToScVal(user, { type: "address" }),
            ],
            i128s([100n, 95n, 953_102n, 900n, 1095n]),
        );

        expect(decodeAMMEvent(event)).toEqual({
            kind: "flash_swap_v",
            receiver,
            user,
            pt_borrowed: 100n,
            v_owed: 95n,
            new_implied_rate: 953_102n,
            new_reserve_a: 900n,
            new_reserve_b: 1095n,
        });
    });
});

// ── the decoder's tolerances, and only those ─────────────────────────────────
//
// Two shapes from older contract builds are accepted by name: swaps without
// the trailing fee fields, and market_created without the creator topic.
// Anything else that departs from the generated layout must throw, so the
// event is stored undecoded rather than written as a coherent, wrong row
// (threat model O-11). Widen a tolerance and one of these fails.
describe("the decoder accepts exactly two legacy shapes", () => {
    const i128s = (values: bigint[]) => nativeToScVal(values, { type: "i128" });
    const swapTopics = () => [
        nativeToScVal("flash_swap_v", { type: "symbol" }),
        nativeToScVal(addr(), { type: "address" }),
        nativeToScVal(addr(), { type: "address" }),
    ];

    it("rejects a vec payload with one value too many", () => {
        const event = fixtureEvent(swapTopics(), i128s([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]));
        expect(() => decodeAMMEvent(event)).toThrow(/expected 7 data values, got 8/);
    });

    it("rejects a vec payload missing a field that is not a known late addition", () => {
        const event = fixtureEvent(swapTopics(), i128s([1n, 2n, 3n, 4n]));
        expect(() => decodeAMMEvent(event)).toThrow(/missing new_reserve_b/);
    });

    it("rejects a topic count that is not the one known prepend", () => {
        const noTopics = fixtureEvent(
            [nativeToScVal("market_created", { type: "symbol" })],
            marketScVal({ name: "x", ym: addr(), pt: addr(), yt: addr(), pool: addr(), maturity: 1n, vault: addr() }),
        );
        expect(() => decodeFactoryEvent(noTopics)).toThrow(/expected 2 topics, got 0/);

        const oneTopicSwap = fixtureEvent(
            [nativeToScVal("flash_swap_v", { type: "symbol" }), nativeToScVal(addr(), { type: "address" })],
            i128s([1n, 2n, 3n, 4n, 5n]),
        );
        expect(() => decodeAMMEvent(oneTopicSwap)).toThrow(/expected 2 topics, got 1/);
    });

    it("accepts market_created without the creator topic and reads vault from the data", () => {
        const vault = addr();
        const market: Market = { name: "old", ym: addr(), pt: addr(), yt: addr(), pool: addr(), maturity: 1n, vault };
        const event = fixtureEvent(
            [nativeToScVal("market_created", { type: "symbol" }), nativeToScVal(vault, { type: "address" })],
            marketScVal(market),
        );
        const decoded = decodeFactoryEvent(event);
        if (decoded.kind !== "market_created") throw new Error(`decoded as ${decoded.kind}`);
        expect(decoded.vault).toBe(vault);
        expect((decoded as { creator?: string }).creator).toBeUndefined();
    });
});
