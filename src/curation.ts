import { Prisma, PrismaClient, Protocol } from "@prisma/client";

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

function prismaCode(err: unknown): string | null {
    return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;
}

export function isNotFound(err: unknown): boolean {
    return prismaCode(err) === "P2025";
}

// Creating a Protocol whose slug is already taken.
export function isAlreadyExists(err: unknown): boolean {
    return prismaCode(err) === "P2002";
}

// Pointing a vault at a `protocolId` that has no Protocol row. Checked by the
// database rather than by a lookup first, so there is no window for the
// protocol to vanish in between.
export function isUnknownProtocol(err: unknown): boolean {
    return prismaCode(err) === "P2003";
}

// ---------------------------------------------------------------------------
// Field validation, shared by the CLI and the HTTP routes so the two surfaces
// cannot drift. Pure, so the rules are unit-tested without a database.

const LONG_MAX = 2000;
const SHORT_MAX = 500;

// The frontend renders these straight into `href` / `<Image src>` on the
// market details page — the one page users trust for "is this protocol real".
// An admin key is the only thing between a curator and that page, so a stolen
// key must not be able to plant a `javascript:` or phishing link. Links must be
// https; the logo is a path into `frontend/public` (or https).
function isHttpsUrl(raw: string): boolean {
    try {
        return new URL(raw).protocol === "https:";
    } catch {
        return false;
    }
}

// A single leading slash, no scheme or authority smuggled in after it
// (`//evil.example` is protocol-relative and would leave the origin), and no
// `..` segments — a path into public/ has no reason to climb.
function isPublicPath(raw: string): boolean {
    return /^\/(?!\/)[A-Za-z0-9._\-\/]*$/.test(raw) && !raw.split("/").includes("..");
}

// Curators type the slug on the command line and it ends up in URLs, so keep
// it to something that needs no quoting or escaping anywhere. Versioned where
// the protocol is (`blendv2`), because a v3 wants a row of its own.
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isProtocolSlug(raw: string): boolean {
    return SLUG.test(raw);
}

type FieldRules<F extends string> = {
    fields: readonly F[];
    long?: ReadonlySet<string>;
    // Fields that may not be cleared with null.
    required?: ReadonlySet<string>;
    // Returns an error for a string value the shape rules reject, else null.
    check: (field: F, raw: string) => string | null;
};

// Flat rather than a discriminated union: tsconfig has `strict: false`, which
// disables the narrowing that would make a union ergonomic at the call sites.
export type ValidationResult<T> = {
    ok: boolean;
    value?: T;
    error?: string;
};

// `null` clears a field; omitting it leaves the stored value alone. `note` is
// skipped, not rejected: it is stored alongside but is not a metadata column.
function parseFields<F extends string>(
    body: unknown,
    rules: FieldRules<F>,
): ValidationResult<Partial<Record<F, string | null>>> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, error: "body must be an object" };
    }

    const value: Partial<Record<F, string | null>> = {};
    for (const [key, raw] of Object.entries(body)) {
        if (key === "note") continue;
        if (!(rules.fields as readonly string[]).includes(key)) {
            return { ok: false, error: `unknown field \`${key}\`` };
        }
        if (raw !== null && typeof raw !== "string") {
            return { ok: false, error: `\`${key}\` must be a string or null` };
        }
        if (raw === null && rules.required?.has(key)) {
            return { ok: false, error: `\`${key}\` cannot be cleared` };
        }

        const field = key as F;
        if (typeof raw === "string") {
            const max = rules.long?.has(key) ? LONG_MAX : SHORT_MAX;
            if (raw.length > max) {
                return { ok: false, error: `\`${key}\` exceeds ${max} chars` };
            }
            const shapeError = rules.check(field, raw);
            if (shapeError) return { ok: false, error: shapeError };
        }
        value[field] = raw;
    }

    if (Object.keys(value).length === 0) {
        return { ok: false, error: "no fields to update" };
    }
    return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Vault: what this particular vault is. The on-chain trio (underlyingSymbol,
// underlyingAsset, pool) is deliberately absent — the indexer owns those, and
// accepting them here would let a hand edit be silently overwritten.

export const VAULT_FIELDS = [
    "displayName",
    "description",
    "riskText",
    "protocolId",
] as const;

export type VaultField = (typeof VAULT_FIELDS)[number];
export type VaultMetadata = Partial<Record<VaultField, string | null>>;

const VAULT_RULES: FieldRules<VaultField> = {
    fields: VAULT_FIELDS,
    long: new Set(["description", "riskText"]),
    check: (field, raw) =>
        field === "protocolId" && !isProtocolSlug(raw)
            ? "`protocolId` must be a slug: lowercase letters, digits and dashes, e.g. `blendv2`"
            : null,
};

export function parseVaultMetadata(body: unknown): ValidationResult<VaultMetadata> {
    return parseFields(body, VAULT_RULES);
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

// ---------------------------------------------------------------------------
// Protocol: the yield protocol a vault lends into. Shared by every vault that
// points at it, which is the whole reason it is a row and not five columns.

export const PROTOCOL_FIELDS = [
    "name",
    "logoUrl",
    "website",
    "docsUrl",
    "auditUrl",
] as const;

export type ProtocolField = (typeof PROTOCOL_FIELDS)[number];
export type ProtocolMetadata = Partial<Record<ProtocolField, string | null>>;

const PROTOCOL_LINK_FIELDS: ReadonlySet<string> = new Set([
    "website",
    "docsUrl",
    "auditUrl",
]);

export function linkFieldError(field: ProtocolField, raw: string): string | null {
    if (PROTOCOL_LINK_FIELDS.has(field) && !isHttpsUrl(raw)) {
        return `\`${field}\` must be an https URL`;
    }
    if (field === "logoUrl" && !isHttpsUrl(raw) && !isPublicPath(raw)) {
        return `\`${field}\` must be a /path into frontend/public or an https URL`;
    }
    return null;
}

const PROTOCOL_RULES: FieldRules<ProtocolField> = {
    fields: PROTOCOL_FIELDS,
    required: new Set(["name"]),
    check: linkFieldError,
};

export function parseProtocolMetadata(
    body: unknown,
): ValidationResult<ProtocolMetadata> {
    return parseFields(body, PROTOCOL_RULES);
}

// Creation needs the slug and a name up front; everything else can follow via
// setProtocolMetadata. Throws P2002 if the slug is taken.
export async function createProtocol(
    prisma: PrismaClient,
    id: string,
    fields: ProtocolMetadata & { name: string },
    note?: string,
) {
    return prisma.protocol.create({
        data: {
            id,
            ...fields,
            curatedAt: new Date(),
            ...(note === undefined ? {} : { curationNote: note }),
        },
    });
}

export async function setProtocolMetadata(
    prisma: PrismaClient,
    id: string,
    fields: ProtocolMetadata,
    note?: string,
) {
    return prisma.protocol.update({
        where: { id },
        data: {
            ...fields,
            curatedAt: new Date(),
            ...(note === undefined ? {} : { curationNote: note }),
        },
    });
}

// The public wire shape predates the Protocol table: the frontend reads
// `protocolName`, `protocolLogoUrl` and friends flat off the vault. Keep that
// contract by projecting the joined row back onto those names. The curation
// note stays private, as it does for vaults and markets.
export function flattenProtocol(protocol: Protocol | null | undefined) {
    return {
        protocolName: protocol?.name ?? null,
        protocolLogoUrl: protocol?.logoUrl ?? null,
        protocolWebsite: protocol?.website ?? null,
        protocolDocsUrl: protocol?.docsUrl ?? null,
        protocolAuditUrl: protocol?.auditUrl ?? null,
    };
}
