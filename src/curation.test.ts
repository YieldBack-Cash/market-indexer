import { describe, it, expect } from "vitest";
import {
    marketWhere,
    parseVaultMetadata,
    parseProtocolMetadata,
    isProtocolSlug,
    flattenProtocol,
    VAULT_FIELDS,
    PROTOCOL_FIELDS,
} from "./curation";

const NOW = 1_800_000_000n;

describe("marketWhere", () => {
    it("defaults closed on both axes", () => {
        expect(marketWhere(NOW)).toEqual({
            listed: true,
            maturity: { gt: NOW },
        });
    });

    it("keeps the listed gate when opting into expired markets", () => {
        expect(marketWhere(NOW, { includeExpired: true })).toEqual({
            listed: true,
        });
    });

    it("keeps the maturity gate when opting into unlisted markets", () => {
        expect(marketWhere(NOW, { includeUnlisted: true })).toEqual({
            maturity: { gt: NOW },
        });
    });

    it("drops both gates only when both flags are set", () => {
        expect(
            marketWhere(NOW, { includeExpired: true, includeUnlisted: true }),
        ).toEqual({});
    });

    it("treats an absent options object the same as an empty one", () => {
        expect(marketWhere(NOW)).toEqual(marketWhere(NOW, {}));
    });
});

describe("parseVaultMetadata", () => {
    it("accepts a subset of the curated fields", () => {
        const result = parseVaultMetadata({
            displayName: "Blend XLM Vault",
            riskText: "Minimal risk.",
        });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({
            displayName: "Blend XLM Vault",
            riskText: "Minimal risk.",
        });
    });

    it("allows null to clear a field", () => {
        const result = parseVaultMetadata({ description: null });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({ description: null });
    });

    it("ignores `note`, which is not a Vault column", () => {
        const result = parseVaultMetadata({
            displayName: "Blend",
            note: "vetted the audit",
        });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({ displayName: "Blend" });
    });

    it("rejects the indexer-owned on-chain columns", () => {
        for (const field of ["underlyingSymbol", "underlyingAsset", "pool"]) {
            const result = parseVaultMetadata({ [field]: "X" });
            expect(result.ok).toBe(false);
            expect(result.error).toContain(field);
        }
    });

    // These moved to the Protocol row. A vault PATCH that still sends them
    // should fail loudly rather than silently drop them.
    it("rejects the old per-vault protocol columns", () => {
        for (const field of [
            "protocolName",
            "protocolLogoUrl",
            "protocolWebsite",
            "protocolDocsUrl",
            "protocolAuditUrl",
        ]) {
            const result = parseVaultMetadata({ [field]: "x" });
            expect(result.ok).toBe(false);
            expect(result.error).toContain(field);
        }
    });

    it("rejects unknown fields", () => {
        const result = parseVaultMetadata({ nope: "x" });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("nope");
    });

    it("rejects non-string values", () => {
        const result = parseVaultMetadata({ displayName: 42 });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("displayName");
    });

    it("caps short fields at 500 and long fields at 2000", () => {
        expect(parseVaultMetadata({ displayName: "x".repeat(500) }).ok).toBe(
            true,
        );
        expect(parseVaultMetadata({ displayName: "x".repeat(501) }).ok).toBe(
            false,
        );
        expect(parseVaultMetadata({ description: "x".repeat(2000) }).ok).toBe(
            true,
        );
        expect(parseVaultMetadata({ description: "x".repeat(2001) }).ok).toBe(
            false,
        );
    });

    it("rejects an empty update and non-object bodies", () => {
        expect(parseVaultMetadata({}).ok).toBe(false);
        expect(parseVaultMetadata({ note: "only a note" }).ok).toBe(false);
        expect(parseVaultMetadata(null).ok).toBe(false);
        expect(parseVaultMetadata([]).ok).toBe(false);
        expect(parseVaultMetadata("x").ok).toBe(false);
    });

    it("accepts every declared field name", () => {
        const body = Object.fromEntries(
            VAULT_FIELDS.map((f) => [f, f === "protocolId" ? "blendv2" : "v"]),
        );
        const result = parseVaultMetadata(body);
        expect(result.ok).toBe(true);
        expect(Object.keys(result.value)).toHaveLength(VAULT_FIELDS.length);
    });

    describe("protocolId", () => {
        it("accepts a slug and null", () => {
            expect(parseVaultMetadata({ protocolId: "blendv2" }).ok).toBe(true);
            expect(parseVaultMetadata({ protocolId: "xoxno" }).ok).toBe(true);
            expect(parseVaultMetadata({ protocolId: null }).ok).toBe(true);
        });

        it("rejects anything that is not a slug", () => {
            for (const bad of ["Blend v2", "BLENDV2", "", "-blend", "blend_v2"]) {
                const result = parseVaultMetadata({ protocolId: bad });
                expect(result.ok, JSON.stringify(bad)).toBe(false);
                expect(result.error).toContain("protocolId");
            }
        });
    });
});

describe("isProtocolSlug", () => {
    it("takes lowercase letters, digits and interior dashes, up to 40 chars", () => {
        for (const ok of ["blendv2", "xoxno", "a", "a-b-c", "x".repeat(40)]) {
            expect(isProtocolSlug(ok), ok).toBe(true);
        }
        for (const bad of ["", "-a", "Blend", "a b", "a/b", "x".repeat(41)]) {
            expect(isProtocolSlug(bad), JSON.stringify(bad)).toBe(false);
        }
    });
});

describe("parseProtocolMetadata", () => {
    it("accepts every declared field name", () => {
        const valid = (f: string) =>
            f === "logoUrl" ? "/BLND.png" : f === "name" ? "Blend" : "https://x.example";
        const body = Object.fromEntries(PROTOCOL_FIELDS.map((f) => [f, valid(f)]));
        const result = parseProtocolMetadata(body);
        expect(result.ok).toBe(true);
        expect(Object.keys(result.value)).toHaveLength(PROTOCOL_FIELDS.length);
    });

    it("rejects the old vault-side names", () => {
        const result = parseProtocolMetadata({ protocolName: "Blend" });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("protocolName");
    });

    it("refuses to clear the name", () => {
        const result = parseProtocolMetadata({ name: null });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("name");
    });

    it("ignores `note` and rejects an empty update", () => {
        expect(parseProtocolMetadata({ name: "Blend", note: "n" }).value).toEqual({
            name: "Blend",
        });
        expect(parseProtocolMetadata({ note: "only a note" }).ok).toBe(false);
    });

    // The details page renders these into `href`, so a stolen admin key must
    // not be able to plant a script or phishing link on the trusted page.
    describe("link fields", () => {
        const LINKS = ["website", "docsUrl", "auditUrl"] as const;

        it("accepts https URLs", () => {
            for (const field of LINKS) {
                expect(parseProtocolMetadata({ [field]: "https://blend.capital/docs" }).ok).toBe(true);
            }
        });

        it("rejects javascript:, data:, http: and bare text", () => {
            for (const field of LINKS) {
                for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://blend.capital", "blend.capital", ""]) {
                    const result = parseProtocolMetadata({ [field]: bad });
                    expect(result.ok, `${field}=${JSON.stringify(bad)}`).toBe(false);
                    expect(result.error).toContain(field);
                }
            }
        });

        it("still allows null to clear a link", () => {
            expect(parseProtocolMetadata({ website: null }).ok).toBe(true);
        });

        it("logo accepts a public path or https, nothing else", () => {
            expect(parseProtocolMetadata({ logoUrl: "/BLND.png" }).ok).toBe(true);
            expect(parseProtocolMetadata({ logoUrl: "https://cdn.example/x.png" }).ok).toBe(true);
            for (const bad of ["//evil.example/x.png", "javascript:alert(1)", "BLND.png", "/x y.png", "/../etc"]) {
                expect(parseProtocolMetadata({ logoUrl: bad }).ok, bad).toBe(false);
            }
        });
    });
});

describe("flattenProtocol", () => {
    const protocol = {
        id: "blendv2",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        name: "Blend Capital",
        logoUrl: "/BLND.png",
        website: "https://blend.capital",
        docsUrl: null,
        auditUrl: null,
        curatedAt: new Date(0),
        curationNote: "internal",
    };

    it("projects the row onto the flat vault field names the frontend reads", () => {
        expect(flattenProtocol(protocol)).toEqual({
            protocolName: "Blend Capital",
            protocolLogoUrl: "/BLND.png",
            protocolWebsite: "https://blend.capital",
            protocolDocsUrl: null,
            protocolAuditUrl: null,
        });
    });

    it("never leaks the curation note", () => {
        expect(Object.keys(flattenProtocol(protocol))).not.toContain("curationNote");
    });

    it("yields all-null for a vault with no protocol", () => {
        expect(Object.values(flattenProtocol(null)).every((v) => v === null)).toBe(true);
    });
});
