// Query-string parsing for the public API, kept apart from api.ts (which
// starts listening when imported) so it can be tested.

/** The most rows any list returns, whatever the caller asks for. */
export const MAX_LIMIT = 500;

/**
 * `limit` is a whole number from 1 to MAX_LIMIT, or absent (then `fallback`);
 * anything else is `null`, which the route answers with a 400.
 * `Math.min(Number(limit) || default, 500)` used to pass a negative value
 * straight to the query, which Postgres reads as "from the other end, no
 * cap", and turned a fraction into an unhandled error (THREAT_MODEL O-6).
 */
export function limitParam(raw: unknown, fallback: number): number | null {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string" || !/^[0-9]{1,4}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= MAX_LIMIT ? n : null;
}

export const LIMIT_ERROR = { error: `\`limit\` must be a whole number from 1 to ${MAX_LIMIT}` };
