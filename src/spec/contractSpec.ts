// Reads event definitions straight out of a Soroban contract binary.
//
// `#[contractevent]` writes each event's topic, data format and parameters,
// in declaration order, into the WASM custom section `contractspecv0` as XDR
// `ScSpecEntry` values. That is the same spec the CLI and bindings generators
// read, so a layout taken from here is the layout the contract publishes, not
// a copy somebody typed from the Rust source.
//
// (The frontend reads error enums from the same section with the same walk;
// the two repos don't share a package yet, so the 40 lines are duplicated.)

import { XdrReader } from "@stellar/js-xdr";
import { xdr } from "@stellar/stellar-sdk";

export type ParamLocation = "topic" | "data";
export type DataFormat = "vec" | "map" | "single";

export interface EventParam {
    name: string;
    in: ParamLocation;
    /** A scalar tag (`i128`, `address`, ...), `udt:<Name>`, `option:<inner>`, or `unknown`. */
    type: string;
}

export interface EventSpec {
    /** The struct name, e.g. `SwapVForPt`. */
    name: string;
    /** The first topic, e.g. `swap_v_for_pt`. */
    topic: string;
    format: DataFormat;
    /** Topic params first, then data params, each in declaration order. */
    params: EventParam[];
}

/** Unsigned LEB128 at `offset`; returns `[value, nextOffset]`. */
function uleb128(bytes: Uint8Array, offset: number): [number, number] {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
        byte = bytes[offset++];
        value |= (byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    return [value, offset];
}

/** The bytes of the named custom section, or null when the module has none. */
export function customSection(wasm: Buffer, wanted: string): Buffer | null {
    if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100) {
        throw new Error("not a WASM module");
    }
    let offset = 8;
    while (offset < wasm.length) {
        const id = wasm[offset++];
        let size: number;
        [size, offset] = uleb128(wasm, offset);
        const end = offset + size;
        if (id === 0) {
            let nameLength: number;
            [nameLength, offset] = uleb128(wasm, offset);
            const name = wasm.subarray(offset, offset + nameLength).toString("utf8");
            if (name === wanted) return wasm.subarray(offset + nameLength, end);
        }
        offset = end;
    }
    return null;
}

const SCALARS: Record<string, string> = {
    scSpecTypeBool: "bool",
    scSpecTypeU32: "u32",
    scSpecTypeI32: "i32",
    scSpecTypeU64: "u64",
    scSpecTypeI64: "i64",
    scSpecTypeTimepoint: "u64",
    scSpecTypeDuration: "u64",
    scSpecTypeU128: "u128",
    scSpecTypeI128: "i128",
    scSpecTypeU256: "u256",
    scSpecTypeI256: "i256",
    scSpecTypeBytes: "bytes",
    scSpecTypeBytesN: "bytes",
    scSpecTypeString: "string",
    scSpecTypeSymbol: "symbol",
    scSpecTypeAddress: "address",
    scSpecTypeMuxedAddress: "address",
};

/** A compact tag for a spec type, enough to pick a TypeScript type for it. */
export function typeTag(def: xdr.ScSpecTypeDef): string {
    const kind = def.switch().name;
    if (kind in SCALARS) return SCALARS[kind];
    if (kind === "scSpecTypeUdt") return `udt:${def.udt().name().toString()}`;
    if (kind === "scSpecTypeOption") return `option:${typeTag(def.option().valueType())}`;
    return "unknown";
}

const FORMATS: Record<string, DataFormat> = {
    scSpecEventDataFormatVec: "vec",
    scSpecEventDataFormatMap: "map",
    scSpecEventDataFormatSingleValue: "single",
};

/** Every event in the binary's spec, in the order the spec lists them. */
export function eventsIn(wasm: Buffer): EventSpec[] {
    const section = customSection(wasm, "contractspecv0");
    if (section == null) throw new Error("no contractspecv0 section");
    const reader = new XdrReader(section);
    const events: EventSpec[] = [];
    while (!reader.eof) {
        const entry = xdr.ScSpecEntry.read(reader);
        if (entry.switch().name !== "scSpecEntryEventV0") continue;
        const spec = entry.eventV0();
        const prefix = spec.prefixTopics();
        if (prefix.length !== 1) {
            throw new Error(`${spec.name().toString()}: expected one prefix topic, got ${prefix.length}`);
        }
        const format = FORMATS[spec.dataFormat().name];
        if (!format) throw new Error(`${spec.name().toString()}: unknown data format`);
        const params: EventParam[] = spec.params().map((p) => ({
            name: p.name().toString(),
            in: p.location().name === "scSpecEventParamLocationTopicList" ? "topic" : "data",
            type: typeTag(p.type()),
        }));
        // The SDK lists topic params before data params; the decoder relies on
        // it, so refuse a spec that doesn't.
        const firstData = params.findIndex((p) => p.in === "data");
        if (firstData !== -1 && params.slice(firstData).some((p) => p.in === "topic")) {
            throw new Error(`${spec.name().toString()}: topic param after a data param`);
        }
        events.push({ name: spec.name().toString(), topic: prefix[0].toString(), format, params });
    }
    return events;
}

/** One generated table: the events of one contract, keyed by topic. */
export interface LayoutTable {
    constKey: string;
    source: string;
    events: EventSpec[];
}

function renderEvent(e: EventSpec): string {
    const params = e.params.map((p) => `{ name: "${p.name}", in: "${p.in}", type: "${p.type}" }`);
    return [
        `        // ${e.name}`,
        `        ${e.topic}: {`,
        `            format: "${e.format}",`,
        `            params: [`,
        ...params.map((p) => `                ${p},`),
        `            ],`,
        `        },`,
    ].join("\n");
}

/**
 * The TypeScript module for the tables. Deterministic (events sorted by
 * topic), so a fresh run against unchanged binaries reproduces the committed
 * file byte for byte.
 */
export function renderModule(tables: LayoutTable[]): string {
    const out = [
        "// GENERATED by src/spec/genEventLayouts.ts from the contract binaries.",
        "// Do not edit: run `npm run gen:events` after rebuilding the contracts.",
        "//",
        "// Each entry is one `#[contractevent]` as its contract's spec declares it:",
        "// the data format and every parameter, in order, with whether it travels",
        "// as a topic or in the data. events.ts decodes by these layouts and types",
        "// its results from them, so a field the contracts add, remove or reorder",
        "// changes the decoder and its types on the next `gen:events` instead of",
        "// silently shifting every column after it.",
        "",
        "export const EVENT_LAYOUTS = {",
    ];
    for (const t of tables) {
        const events = [...t.events].sort((a, b) => a.topic.localeCompare(b.topic));
        for (const e of events) {
            const dupe = events.find((o) => o !== e && o.topic === e.topic);
            if (dupe) throw new Error(`${t.source}: two events share the topic ${e.topic}`);
        }
        out.push(`    /** From ${t.source}. */`);
        out.push(`    ${t.constKey}: {`);
        out.push(events.map(renderEvent).join("\n\n"));
        out.push("    },");
    }
    out.push("} as const;");
    out.push("");
    return out.join("\n");
}
