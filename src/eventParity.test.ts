import { readFileSync } from "node:fs";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { EVENT_LAYOUTS } from "./eventLayouts.generated";
import { decodeAMMEvent, decodeFactoryEvent, decodeRouterEvent, decodeYmEvent } from "./events";
import { eventsIn, renderModule } from "./spec/contractSpec";
import { CONTRACTS_DIR, OUTPUT, allBinariesPresent, generate } from "./spec/genEventLayouts";

// The layouts the decoder reads by are generated from the contract binaries,
// never typed. These tests keep the committed copy honest and prove the
// decoder refuses a payload that doesn't match its layout, which is how a
// reordered or inserted field used to corrupt every column after it.

const DECODERS = {
    factory: decodeFactoryEvent,
    ym: decodeYmEvent,
    amm: decodeAMMEvent,
    router: decodeRouterEvent,
} as const;

type Param = { readonly name: string; readonly in: "topic" | "data"; readonly type: string };
type Layout = { readonly format: "vec" | "map" | "single"; readonly params: readonly Param[] };

const address = () => Keypair.random().publicKey();

/** A native value of the layout's declared type, distinct per field. */
function sample(type: string, i: number): unknown {
    switch (type) {
        case "address":
            return address();
        case "u32":
        case "i32":
            return i;
        case "bytes":
            return Buffer.alloc(32, i);
        case "bool":
            return true;
        case "string":
        case "symbol":
            return `s${i}`;
        default:
            // Every integer, and any UDT: a bigint round-trips through i128
            // and is enough to prove the field landed under the right name.
            return BigInt(1000 + i);
    }
}

function toScVal(type: string, native: unknown): xdr.ScVal {
    if (type === "address") return nativeToScVal(native, { type: "address" });
    if (type === "u32" || type === "i32") return nativeToScVal(native, { type });
    if (type === "string" || type === "symbol") return nativeToScVal(native, { type });
    if (typeof native === "bigint") return nativeToScVal(native, { type: "i128" });
    return nativeToScVal(native);
}

/** A raw event built from a layout, plus the fields the decoder should return. */
function eventFor(topic: string, layout: Layout, dataCount?: number) {
    const expected: Record<string, unknown> = { kind: topic };
    const topics = [nativeToScVal(topic, { type: "symbol" })];
    const data: [string, string, unknown][] = [];
    layout.params.forEach((p, i) => {
        const native = sample(p.type, i + 1);
        expected[p.name] = native;
        if (p.in === "topic") topics.push(toScVal(p.type, native));
        else data.push([p.name, p.type, native]);
    });
    const kept = dataCount == null ? data : data.slice(0, dataCount);
    let value: xdr.ScVal;
    if (layout.format === "single") value = toScVal(kept[0][1], kept[0][2]);
    else if (layout.format === "vec") value = xdr.ScVal.scvVec(kept.map(([, t, n]) => toScVal(t, n)));
    else {
        value = xdr.ScVal.scvMap(
            kept.map(
                ([name, t, n]) =>
                    new xdr.ScMapEntry({ key: nativeToScVal(name, { type: "symbol" }), val: toScVal(t, n) }),
            ),
        );
    }
    const raw = {
        id: "0000000100000000-0000000000",
        type: "contract",
        ledger: 100,
        ledgerClosedAt: new Date().toISOString(),
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        txHash: "deadbeef",
        topic: topics,
        value,
    } as rpc.Api.EventResponse;
    return { raw, expected };
}

// Needs the sibling ybc-contracts checkout with its release build; a clone
// without one skips this and trusts the committed file, which
// `npm run check:events` verifies wherever the binaries are.
describe.skipIf(!allBinariesPresent())(`generated layouts match the binaries in ${CONTRACTS_DIR}`, () => {
    it("is byte-identical to a fresh run (else: npm run gen:events)", () => {
        expect(readFileSync(OUTPUT, "utf8")).toBe(generate());
    });
});

// Exhaustive by construction: every event every contract declares, with a
// payload shaped exactly as its layout says, lands each value under its own
// field name. This replaces the hand-kept list of topics, which could only
// say that an event was known, not that its fields were read in order.
describe("every event a contract declares decodes field for field", () => {
    for (const [contract, layouts] of Object.entries(EVENT_LAYOUTS)) {
        const decode = DECODERS[contract as keyof typeof DECODERS];
        it.each(Object.keys(layouts))(`${contract}: %s`, (topic) => {
            const { raw, expected } = eventFor(topic, (layouts as Record<string, Layout>)[topic]);
            expect(decode(raw)).toEqual(expected);
        });
    }
});

describe("a payload that doesn't match its layout is refused, not misread", () => {
    const swap = EVENT_LAYOUTS.amm.swap_v_for_pt;
    const dataCount = swap.params.filter((p) => p.in === "data").length;

    it("throws on a vec with a field missing before the end", () => {
        // The fee fields at the tail may be absent (older pools); anything
        // before them may not.
        const { raw } = eventFor("swap_v_for_pt", swap, dataCount - 3);
        expect(() => decodeAMMEvent(raw)).toThrow(/expected \d+ data values, got \d+ \(missing/);
    });

    it("throws on a vec with an extra field", () => {
        const { raw } = eventFor("swap_v_for_pt", swap);
        const vec = raw.value.vec()!;
        raw.value = xdr.ScVal.scvVec([...vec, nativeToScVal(1n, { type: "i128" })]);
        expect(() => decodeAMMEvent(raw)).toThrow(/expected \d+ data values, got \d+/);
    });

    it("throws on a vec where a map was declared, and on a map missing a field", () => {
        const init = EVENT_LAYOUTS.amm.pool_init;
        const { raw } = eventFor("pool_init", init);
        raw.value = xdr.ScVal.scvMap(raw.value.map()!.slice(1));
        expect(() => decodeAMMEvent(raw)).toThrow(/data has no expiry_ts/);

        const { raw: asVec } = eventFor("deposit", EVENT_LAYOUTS.ym.deposit);
        asVec.value = xdr.ScVal.scvMap([]);
        expect(() => decodeYmEvent(asVec)).toThrow(/expected 3 data values/);
    });

    it("throws on the wrong number of topics", () => {
        const { raw } = eventFor("deposit", EVENT_LAYOUTS.ym.deposit);
        raw.topic = [...raw.topic, nativeToScVal(address(), { type: "address" })];
        expect(() => decodeYmEvent(raw)).toThrow(/expected 1 topics, got 2/);
    });

    it("still throws on a topic no layout declares", () => {
        const { raw } = eventFor("deposit", EVENT_LAYOUTS.ym.deposit);
        raw.topic[0] = nativeToScVal("something_new", { type: "symbol" });
        expect(() => decodeYmEvent(raw)).toThrow(/Unknown YM Event: something_new/);
    });
});

describe("shapes older contract builds published", () => {
    it("reads a trade without the fee fields and leaves them unset", () => {
        const swap = EVENT_LAYOUTS.amm.swap_pt_for_v;
        const dataCount = swap.params.filter((p) => p.in === "data").length;
        const { raw, expected } = eventFor("swap_pt_for_v", swap, dataCount - 2);
        delete expected.fee;
        delete expected.reserve_fee;
        const decoded = decodeAMMEvent(raw);
        expect(decoded).toEqual(expected);
        expect("fee" in decoded).toBe(false);
    });

    it("reads market_created without the creator topic, taking the vault from the data", () => {
        const { raw, expected } = eventFor("market_created", EVENT_LAYOUTS.factory.market_created);
        const vault = address();
        const market = { ym: address(), pt: address(), yt: address(), pool: address(), maturity: 1n, vault };
        raw.topic = [raw.topic[0], nativeToScVal(vault, { type: "address" })];
        raw.value = nativeToScVal(market, {
            type: {
                ym: ["symbol", "address"],
                pt: ["symbol", "address"],
                yt: ["symbol", "address"],
                pool: ["symbol", "address"],
                maturity: ["symbol", "u64"],
                vault: ["symbol", "address"],
            },
        });
        delete expected.creator;
        expect(decodeFactoryEvent(raw)).toEqual({ ...expected, vault, market });
    });

    it("prefers the vault in the data over the topic even on the current shape", () => {
        const { raw } = eventFor("market_created", EVENT_LAYOUTS.factory.market_created);
        const vault = address();
        const market = { ym: address(), pt: address(), yt: address(), pool: address(), maturity: 1n, vault };
        raw.value = nativeToScVal(market, {
            type: {
                ym: ["symbol", "address"],
                pt: ["symbol", "address"],
                yt: ["symbol", "address"],
                pool: ["symbol", "address"],
                maturity: ["symbol", "u64"],
                vault: ["symbol", "address"],
            },
        });
        const decoded = decodeFactoryEvent(raw);
        expect(decoded.kind).toBe("market_created");
        if (decoded.kind === "market_created") expect(decoded.vault).toBe(vault);
    });
});

describe("the spec reader", () => {
    it("reads an event's format and ordered params out of a hand-built module", () => {
        const entry = xdr.ScSpecEntry.scSpecEntryEventV0(
            new xdr.ScSpecEventV0({
                doc: "",
                lib: "",
                name: "Thing",
                prefixTopics: ["thing"],
                params: [
                    new xdr.ScSpecEventParamV0({
                        doc: "",
                        name: "who",
                        type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
                        location: xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationTopicList(),
                    }),
                    new xdr.ScSpecEventParamV0({
                        doc: "",
                        name: "how_much",
                        type: xdr.ScSpecTypeDef.scSpecTypeI128(),
                        location: xdr.ScSpecEventParamLocationV0.scSpecEventParamLocationData(),
                    }),
                ],
                dataFormat: xdr.ScSpecEventDataFormat.scSpecEventDataFormatVec(),
            }),
        ).toXDR();
        const name = Buffer.from("contractspecv0");
        const payload = Buffer.concat([Buffer.from([name.length]), name, entry]);
        const wasm = Buffer.concat([
            Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
            Buffer.from([0x00, payload.length]),
            payload,
        ]);
        expect(eventsIn(wasm)).toEqual([
            {
                name: "Thing",
                topic: "thing",
                format: "vec",
                params: [
                    { name: "who", in: "topic", type: "address" },
                    { name: "how_much", in: "data", type: "i128" },
                ],
            },
        ]);
        expect(renderModule([{ constKey: "x", source: "x.wasm", events: eventsIn(wasm) }])).toContain(
            '{ name: "how_much", in: "data", type: "i128" }',
        );
    });

    it("refuses a module without a spec", () => {
        expect(() => eventsIn(Buffer.from("not wasm"))).toThrow(/WASM/);
    });
});
