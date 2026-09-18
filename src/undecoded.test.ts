import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { alreadyApplied, UNDECODED, undecodedPayload } from "./undecoded";

describe("alreadyApplied", () => {
    it("applies an event it has never seen", async () => {
        const remove = vi.fn();
        expect(await alreadyApplied(null, remove)).toBe(false);
        expect(remove).not.toHaveBeenCalled();
    });

    it("skips an event already applied, so replays stay idempotent", async () => {
        const remove = vi.fn();
        expect(await alreadyApplied({ type: "deposit_asset" }, remove)).toBe(true);
        expect(remove).not.toHaveBeenCalled();
    });

    it("replaces a placeholder, so a backfill recovers what an older build couldn't decode", async () => {
        const remove = vi.fn().mockResolvedValue(undefined);
        expect(await alreadyApplied({ type: UNDECODED }, remove)).toBe(false);
        expect(remove).toHaveBeenCalledOnce();
    });
});

describe("undecodedPayload", () => {
    it("keeps enough to decode the event later, and names no wallet", () => {
        const raw = {
            topic: [nativeToScVal("brand_new_event", { type: "symbol" })],
            value: nativeToScVal([7n], { type: "i128" }),
        } as rpc.Api.EventResponse;

        const payload = undecodedPayload(raw, new Error("Unknown YM Event: brand_new_event")) as {
            topic: string[];
            value: string;
            error: string;
        };

        expect(scValToNative(xdr.ScVal.fromXDR(payload.topic[0], "base64"))).toBe("brand_new_event");
        expect(scValToNative(xdr.ScVal.fromXDR(payload.value, "base64"))).toEqual([7n]);
        expect(payload.error).toMatch(/brand_new_event/);
        // the account endpoint and the app's history both select on these
        expect(payload).not.toHaveProperty("from");
        expect(payload).not.toHaveProperty("to");
        expect(payload).not.toHaveProperty("user");
    });
});
