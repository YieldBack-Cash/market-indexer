import { describe, expect, it, vi } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import { cursorLedger, fetchEvents, type EventClient } from "./stellar";

const TIP = 4_924_595;
const START = 4_906_515;
const WINDOW = 10_000;

/** A pagination cursor as the RPC formats it: TOID with the ledger in the top 32 bits. */
const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;

const event = (ledger: number, n = 0) =>
    ({ id: `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-${String(n).padStart(10, "0")}`, ledger }) as rpc.Api.EventResponse;

const response = (events: rpc.Api.EventResponse[], cursor: number, latestLedger = TIP) =>
    ({ events, cursor: cursorAt(cursor), latestLedger }) as unknown as rpc.Api.GetEventsResponse;

const client = (...responses: rpc.Api.GetEventsResponse[]): EventClient & { getEvents: ReturnType<typeof vi.fn> } => {
    const getEvents = vi.fn();
    for (const r of responses) getEvents.mockResolvedValueOnce(r);
    return { getEvents };
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `C${String(i).padStart(55, "A")}`);

describe("cursorLedger", () => {
    it("reads the ledger out of a TOID cursor", () => {
        expect(cursorLedger("0021116271135293439-4294967295")).toBe(4_916_514);
        expect(cursorLedger(cursorAt(TIP))).toBe(TIP);
    });

    it("refuses anything that is not a TOID", () => {
        expect(cursorLedger("")).toBeUndefined();
        expect(cursorLedger("abc-1")).toBeUndefined();
    });
});

describe("fetchEvents follows the RPC to the tip", () => {
    it("keeps asking when the scan window ran out before the tip, even with no events", async () => {
        // The failure this exists for: the RPC scans ~10,000 ledgers, finds
        // nothing, and hands back a cursor. An event 16,000 ledgers ahead is
        // invisible to a single request.
        const late = event(START + 16_948);
        const rpcClient = client(
            response([], START + WINDOW - 1),
            response([late], TIP),
        );

        const batch = await fetchEvents(ids(1), START, rpcClient);

        expect(batch.events).toEqual([late]);
        expect(batch.scannedTo).toBe(TIP);
        expect(batch.latestLedger).toBe(TIP);
        expect(rpcClient.getEvents).toHaveBeenCalledTimes(2);
        expect(rpcClient.getEvents.mock.calls[1][0]).toMatchObject({ cursor: cursorAt(START + WINDOW - 1) });
        expect(rpcClient.getEvents.mock.calls[1][0]).not.toHaveProperty("startLedger");
    });

    it("keeps paging while pages come back full", async () => {
        const page = Array.from({ length: 1000 }, (_, i) => event(START + 1, i));
        const rpcClient = client(
            response(page, START + 1),
            response([event(START + 2)], TIP),
        );

        const batch = await fetchEvents(ids(1), START, rpcClient);

        expect(batch.events).toHaveLength(1001);
        expect(batch.scannedTo).toBe(TIP);
    });

    it("stops once the scan has reached the tip", async () => {
        const rpcClient = client(response([event(START + 5)], TIP));

        const batch = await fetchEvents(ids(1), START, rpcClient);

        expect(rpcClient.getEvents).toHaveBeenCalledTimes(1);
        expect(batch.scannedTo).toBe(TIP);
    });

    it("packs up to 25 contracts into one request, five per filter", async () => {
        const rpcClient = client(response([], TIP));

        await fetchEvents(ids(25), START, rpcClient);

        expect(rpcClient.getEvents).toHaveBeenCalledTimes(1);
        const { filters } = rpcClient.getEvents.mock.calls[0][0];
        expect(filters).toHaveLength(5);
        expect(filters.every((f: { contractIds: string[] }) => f.contractIds.length === 5)).toBe(true);
    });

    it("splits more than 25 contracts across requests and reports the least-covered ledger", async () => {
        const rpcClient = client(
            response([], TIP), // first 25 contracts, scanned to the tip
            response([], TIP - 3, TIP), // the 26th: RPC stopped short and repeats itself
            response([], TIP - 3, TIP),
        );

        const batch = await fetchEvents(ids(26), START, rpcClient);

        expect(rpcClient.getEvents).toHaveBeenCalledTimes(3);
        // A cursor that never advances ends the scan where it stands rather than
        // looping, and the cursor only advances to what every request covered.
        expect(batch.scannedTo).toBe(TIP - 3);
    });

    it("does not lose ledgers to an event-only view of progress", async () => {
        // Events in the second window but a cursor at the tip: scannedTo is the
        // tip, so the next poll does not re-read the whole span.
        const rpcClient = client(response([], START + WINDOW - 1), response([event(START + WINDOW + 10)], TIP));

        const batch = await fetchEvents(ids(3), START, rpcClient);

        expect(batch.scannedTo).toBe(TIP);
    });
});
