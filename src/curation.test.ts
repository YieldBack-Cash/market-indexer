import { describe, it, expect } from "vitest";
import { marketWhere, parseVaultMetadata, VAULT_FIELDS } from "./curation";

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
            protocolName: "Blend Capital",
            riskText: "Minimal risk.",
        });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({
            protocolName: "Blend Capital",
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
            protocolName: "Blend",
            note: "vetted the audit",
        });
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({ protocolName: "Blend" });
    });

    it("rejects the indexer-owned on-chain columns", () => {
        for (const field of ["underlyingSymbol", "underlyingAsset", "pool"]) {
            const result = parseVaultMetadata({ [field]: "X" });
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
        const result = parseVaultMetadata({ protocolName: 42 });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("protocolName");
    });

    it("caps short fields at 500 and long fields at 2000", () => {
        expect(parseVaultMetadata({ protocolName: "x".repeat(500) }).ok).toBe(
            true,
        );
        expect(parseVaultMetadata({ protocolName: "x".repeat(501) }).ok).toBe(
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
        const body = Object.fromEntries(VAULT_FIELDS.map((f) => [f, "v"]));
        const result = parseVaultMetadata(body);
        expect(result.ok).toBe(true);
        expect(Object.keys(result.value)).toHaveLength(VAULT_FIELDS.length);
    });
});
