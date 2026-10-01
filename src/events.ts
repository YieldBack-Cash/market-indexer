import { scValToNative } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { EVENT_LAYOUTS } from "./eventLayouts.generated";

// Events are decoded by the layouts in eventLayouts.generated.ts, which
// `npm run gen:events` reads out of each contract binary's spec: the data
// format and every parameter in declaration order. Nothing here names a field
// position. A vec event whose length doesn't match its layout throws (and is
// stored undecoded by the indexer) instead of shifting every column after the
// change; a field the contracts add or reorder changes the layouts, the
// decoder and the types below together on the next regeneration.

export interface Market {
    name?: string;
    ym: string;
    pt: string;
    yt: string;
    pool: string;
    maturity: bigint;
    vault: string;
}

export interface WasmHashes {
    pt: string;
    yt: string;
    ym: string;
    amm: string;
}

// ── types derived from the layouts ──────────────────────────────────────────

type Param = { readonly name: string; readonly in: "topic" | "data"; readonly type: string };
type Layout = { readonly format: "vec" | "map" | "single"; readonly params: readonly Param[] };
type Layouts = typeof EVENT_LAYOUTS;

/** Contract structs the indexer has a shape for; any other UDT decodes as `unknown`. */
type Udts = { Market: Market; WasmHashes: WasmHashes };

/** The TypeScript type `scValToNative` yields for a spec type tag. */
type TsType<T extends string> = T extends "i128" | "u128" | "i64" | "u64" | "i256" | "u256"
    ? bigint
    : T extends "u32" | "i32"
      ? number
      : T extends "address" | "string" | "symbol"
        ? string
        : T extends "bool"
          ? boolean
          : T extends "bytes"
            ? Buffer
            : T extends `udt:${infer U}`
              ? U extends keyof Udts
                  ? Udts[U]
                  : unknown
              : T extends `option:${infer I}`
                ? TsType<I> | undefined
                : unknown;

// Fields appended to events that were already on chain. Pools deployed from
// AMM wasm older than the fee fields publish without them, so they stay
// optional and the decoder accepts their absence; every other field is
// required, in type and at decode time.
type AddedLater = "fee" | "reserve_fee";
const ADDED_LATER: ReadonlySet<string> = new Set<AddedLater>(["fee", "reserve_fee"]);

// Topic params prepended to an event already on chain. MarketCreated gained a
// `creator` topic ahead of `vault`, so older events carry one topic fewer;
// the decoder right-aligns those. (The data payload carries `vault` in both
// shapes and wins, see decodeFactoryEvent.)
const TOPICS_PREPENDED_LATER: Readonly<Record<string, number>> = { market_created: 1 };

type Fields<L extends Layout> = {
    [P in L["params"][number] as P["name"] extends AddedLater ? never : P["name"]]: TsType<P["type"]>;
} & {
    [P in L["params"][number] as P["name"] extends AddedLater ? P["name"] : never]?: TsType<P["type"]>;
};

type DecodedOf<G extends Record<string, Layout>> = {
    [K in keyof G & string]: { kind: K } & Fields<G[K]>;
}[keyof G & string];

export type DecodedFactoryEvent = DecodedOf<Layouts["factory"]>;
export type DecodedYmEvent = DecodedOf<Layouts["ym"]>;
export type DecodedAMMEvent = DecodedOf<Layouts["amm"]>;
export type DecodedRouterEvent = DecodedOf<Layouts["router"]>;

// ── the decoder ─────────────────────────────────────────────────────────────

function decodeWith<G extends Record<string, Layout>>(
    group: G,
    label: string,
    raw: rpc.Api.EventResponse,
): DecodedOf<G> {
    const topics = raw.topic.map(scValToNative);
    const name = topics[0] as string;
    const layout: Layout | undefined = group[name];
    if (!layout) throw new Error(`Unknown ${label}: ${name}`);

    const topicParams = layout.params.filter((p) => p.in === "topic");
    const dataParams = layout.params.filter((p) => p.in === "data");
    const fields: Record<string, unknown> = { kind: name };

    // Topics: the first is the event name, the rest line up with the layout.
    const given = topics.length - 1;
    const missing = topicParams.length - given;
    if (missing !== 0 && missing !== (TOPICS_PREPENDED_LATER[name] ?? 0)) {
        throw new Error(`${label} ${name}: expected ${topicParams.length} topics, got ${given}`);
    }
    topicParams.forEach((p, i) => {
        if (i >= missing) fields[p.name] = topics[1 + i - missing];
    });

    // Data: by position for `vec`, by name for `map`, the value itself for
    // `single`. The positional case is the one that could misread, so its
    // length must match the layout exactly, save for trailing fields that
    // older contract builds are known not to publish.
    const value = scValToNative(raw.value);
    switch (layout.format) {
        case "single":
            fields[dataParams[0].name] = value;
            break;
        case "map":
            for (const p of dataParams) {
                if (value != null && p.name in value) fields[p.name] = value[p.name];
                else if (!ADDED_LATER.has(p.name)) throw new Error(`${label} ${name}: data has no ${p.name}`);
            }
            break;
        case "vec": {
            if (!Array.isArray(value) || value.length > dataParams.length) {
                throw new Error(
                    `${label} ${name}: expected ${dataParams.length} data values, got ${
                        Array.isArray(value) ? value.length : typeof value
                    }`,
                );
            }
            const omitted = dataParams.slice(value.length).filter((p) => !ADDED_LATER.has(p.name));
            if (omitted.length > 0) {
                throw new Error(
                    `${label} ${name}: expected ${dataParams.length} data values, got ${value.length} ` +
                        `(missing ${omitted.map((p) => p.name).join(", ")})`,
                );
            }
            value.forEach((v, i) => {
                fields[dataParams[i].name] = v;
            });
            break;
        }
    }
    return fields as DecodedOf<G>;
}

export function decodeFactoryEvent(raw: rpc.Api.EventResponse): DecodedFactoryEvent {
    const decoded = decodeWith(EVENT_LAYOUTS.factory, "factory event", raw);
    // The vault comes from the event's data, not a topic. When MarketCreated
    // gained its `creator` topic, topics[1] silently became the creator and
    // whole markets were keyed under an account address. `market.vault` is in
    // both the old and new shapes, so it cannot drift again.
    if (decoded.kind === "market_created") return { ...decoded, vault: decoded.market?.vault ?? decoded.vault };
    return decoded;
}

export function decodeYmEvent(raw: rpc.Api.EventResponse): DecodedYmEvent {
    return decodeWith(EVENT_LAYOUTS.ym, "YM Event", raw);
}

export function decodeAMMEvent(raw: rpc.Api.EventResponse): DecodedAMMEvent {
    return decodeWith(EVENT_LAYOUTS.amm, "AMM event", raw);
}

/// The router's own record of a user action: one event per entrypoint, named
/// after it (`zap_asset_for_pt`, `zap_yt_for_asset`, `swap_v_for_yt`,
/// `exit_expired_to_asset`, ...), carrying the asset and the amounts that
/// actually moved. Every one names its market by `vault` and `maturity`.
export function decodeRouterEvent(raw: rpc.Api.EventResponse): DecodedRouterEvent {
    return decodeWith(EVENT_LAYOUTS.router, "router event", raw);
}
