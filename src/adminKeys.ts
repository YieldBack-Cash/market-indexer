import { timingSafeEqual } from "node:crypto";

// One credential per curator, so a listing decision can be traced to the
// person who made it (THREAT_MODEL O-8). `ADMIN_API_KEYS` is a comma-separated
// list of `name=secret`; the name is what gets written to `curatedBy`. The
// older single `ADMIN_API_KEY` is still honoured, as the curator "admin", so an
// existing deployment keeps working until its keys are split.

export type AdminKey = { curator: string; secret: string };

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

/** Parses the configured credentials; throws on a malformed entry rather than silently skipping it. */
export function parseAdminKeys(env: { ADMIN_API_KEYS?: string; ADMIN_API_KEY?: string }): AdminKey[] {
    const keys: AdminKey[] = [];
    for (const entry of (env.ADMIN_API_KEYS ?? "").split(",")) {
        const trimmed = entry.trim();
        if (trimmed === "") continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) throw new Error(`ADMIN_API_KEYS: entry is not name=secret: ${JSON.stringify(trimmed)}`);
        const curator = trimmed.slice(0, eq).trim();
        const secret = trimmed.slice(eq + 1).trim();
        if (!NAME.test(curator)) throw new Error(`ADMIN_API_KEYS: bad curator name ${JSON.stringify(curator)}`);
        if (secret.length < 16) throw new Error(`ADMIN_API_KEYS: secret for ${curator} is too short (16 characters at least)`);
        if (keys.some((k) => k.curator === curator)) throw new Error(`ADMIN_API_KEYS: curator ${curator} listed twice`);
        keys.push({ curator, secret });
    }
    if (env.ADMIN_API_KEY) keys.push({ curator: "admin", secret: env.ADMIN_API_KEY });
    return keys;
}

/**
 * The curator whose secret matches `provided`, or null. Every configured key
 * is compared, in constant time each, whether or not an earlier one matched,
 * so the response time says nothing about which key was close.
 */
export function matchAdminKey(keys: AdminKey[], provided: string): string | null {
    const a = Buffer.from(provided);
    let matched: string | null = null;
    for (const { curator, secret } of keys) {
        const b = Buffer.from(secret);
        // timingSafeEqual throws on a length mismatch, so check that first. The
        // length itself leaks, which is acceptable for a random secret.
        if (a.length === b.length && timingSafeEqual(a, b) && matched === null) matched = curator;
    }
    return matched;
}
