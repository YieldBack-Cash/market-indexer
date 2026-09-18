import type { Prisma } from "@prisma/client";
import type { rpc } from "@stellar/stellar-sdk";

// An event this build can't decode is stored as-is rather than only logged, so
// a later decoder can recover it from the database — the RPC keeps events for
// days, not forever. The raw XDR is enough to re-decode; nothing here names a
// wallet, so no API consumer mistakes it for account activity.
export const UNDECODED = "undecoded";

export function undecodedPayload(raw: rpc.Api.EventResponse, err: unknown): Prisma.InputJsonValue {
    return {
        topic: raw.topic.map((t) => t.toXDR("base64")),
        value: raw.value.toXDR("base64"),
        error: err instanceof Error ? err.message : String(err),
    };
}

/**
 * Whether an event id is already applied, for the idempotency check. A
 * placeholder gives way to the real event: without this, the id check that
 * makes replays safe would keep an undecoded row forever, and a backfill with a
 * fixed decoder would skip straight past the event it exists to recover.
 */
export async function alreadyApplied(
    existing: { type: string } | null,
    remove: () => Promise<unknown>,
): Promise<boolean> {
    if (!existing) return false;
    if (existing.type !== UNDECODED) return true;
    await remove();
    return false;
}
