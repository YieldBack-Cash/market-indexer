import { Prisma, PrismaClient } from "@prisma/client";

export type MarketFilter = {
    includeExpired?: boolean;
    includeUnlisted?: boolean;
};

// Single source of truth for "which markets may the frontend see". Both
// defaults are deliberately closed: a market is hidden until curated, and
// matured markets drop out unless a caller opts in.
export function marketWhere(
    now: bigint,
    opts: MarketFilter = {},
): Prisma.MarketWhereInput {
    return {
        ...(opts.includeUnlisted ? {} : { listed: true }),
        ...(opts.includeExpired ? {} : { maturity: { gt: now } }),
    };
}

export const MARKET_ORDER = { maturity: "asc" } as const;

// Thrown to callers as Prisma P2025 when the id doesn't exist — the admin
// route maps it to 404, the CLI to a non-zero exit.
export async function setListed(
    prisma: PrismaClient,
    id: string,
    listed: boolean,
    note?: string,
) {
    return prisma.market.update({
        where: { id },
        data: {
            listed,
            curatedAt: new Date(),
            curationNote: note ?? null,
        },
    });
}

export function isNotFound(err: unknown): boolean {
    return (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
    );
}

// The curated columns on Vault. The on-chain trio (underlyingSymbol,
// underlyingAsset, pool) is deliberately absent — the indexer owns those, and
// accepting them here would let a hand edit be silently overwritten.
export const VAULT_FIELDS = [
    "displayName",
    "protocolName",
    "protocolLogoUrl",
    "protocolWebsite",
    "protocolDocsUrl",
    "protocolAuditUrl",
    "description",
    "riskText",
] as const;

export type VaultField = (typeof VAULT_FIELDS)[number];
export type VaultMetadata = Partial<Record<VaultField, string | null>>;

const LONG_FIELDS: ReadonlySet<string> = new Set(["description", "riskText"]);
const LONG_MAX = 2000;
const SHORT_MAX = 500;

export function maxLengthFor(field: VaultField): number {
    return LONG_FIELDS.has(field) ? LONG_MAX : SHORT_MAX;
}

// Flat rather than a discriminated union: tsconfig has `strict: false`, which
// disables the narrowing that would make a union ergonomic at the call sites.
export type ValidationResult = {
    ok: boolean;
    value?: VaultMetadata;
    error?: string;
};

// Pure so the rules can be unit-tested without a database or an HTTP layer.
// `null` clears a field; omitting it leaves the stored value alone.
export function parseVaultMetadata(body: unknown): ValidationResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, error: "body must be an object" };
    }

    const value: VaultMetadata = {};
    for (const [key, raw] of Object.entries(body)) {
        if (key === "note") continue; // handled separately, not a Vault column
        if (!(VAULT_FIELDS as readonly string[]).includes(key)) {
            return { ok: false, error: `unknown field \`${key}\`` };
        }
        if (raw !== null && typeof raw !== "string") {
            return { ok: false, error: `\`${key}\` must be a string or null` };
        }

        const field = key as VaultField;
        const max = maxLengthFor(field);
        if (typeof raw === "string" && raw.length > max) {
            return { ok: false, error: `\`${key}\` exceeds ${max} chars` };
        }
        value[field] = raw;
    }

    if (Object.keys(value).length === 0) {
        return { ok: false, error: "no fields to update" };
    }
    return { ok: true, value };
}

export async function setVaultMetadata(
    prisma: PrismaClient,
    address: string,
    fields: VaultMetadata,
    note?: string,
) {
    return prisma.vault.update({
        where: { address },
        data: {
            ...fields,
            curatedAt: new Date(),
            ...(note === undefined ? {} : { curationNote: note }),
        },
    });
}
