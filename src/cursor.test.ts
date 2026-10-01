import { describe, expect, it } from "vitest";
import { marketNameFor, retentionGap, sanitizeLabel } from "./cursor";

const VAULT = "CBER44PSDF3X3XTL5LUNRFMQMYHNDMJELEADPCBQDJZXTXKXCGNNMGQG";

describe("marketNameFor", () => {
    it("uses the name the factory emitted", () => {
        expect(marketNameFor({ name: "bvXLM-23DEC2026", maturity: 1797984000n }, VAULT, "XLM")).toBe("bvXLM-23DEC2026");
    });

    it("falls back to symbol and date for a factory that emitted no name", () => {
        expect(marketNameFor({ maturity: 1797984000n }, VAULT, "XLM")).toBe("XLM-2026-12-23");
    });

    it("falls back to the vault prefix when the vault would not even say its symbol", () => {
        expect(marketNameFor({ name: "", maturity: 1797984000n }, VAULT, undefined)).toBe("CBER44PS-2026-12-23");
    });
});

describe("retentionGap", () => {
    it("is zero while the cursor is inside the RPC's window", () => {
        expect(retentionGap(4_906_515, 4_803_636)).toBe(0);
        expect(retentionGap(4_803_636, 4_803_636)).toBe(0);
    });

    it("counts the ledgers that are gone for good", () => {
        expect(retentionGap(4_570_001, 4_582_773)).toBe(12_772);
    });
});

describe("sanitizeLabel", () => {
    it("keeps an ordinary symbol as it is", () => {
        expect(sanitizeLabel("bvXLM", 32, "?")).toBe("bvXLM");
        expect(sanitizeLabel("USDC (Circle)", 32, "?")).toBe("USDC (Circle)");
    });

    it("strips terminal escapes and other control characters", () => {
        expect(sanitizeLabel("XLM\u001b[31m\u0007", 32, "?")).toBe("XLM[31m");
        expect(sanitizeLabel("a\u0000b\nc\td", 32, "?")).toBe("ab c d");
    });

    it("strips bidi overrides and zero-width characters that could disguise a name", () => {
        expect(sanitizeLabel("‮MLX‬", 32, "?")).toBe("MLX");
        expect(sanitizeLabel("XL​M﻿", 32, "?")).toBe("XLM");
    });

    it("cuts to the maximum without splitting a character", () => {
        expect(sanitizeLabel("A".repeat(100), 32, "?")).toBe("A".repeat(32));
        expect(sanitizeLabel("😀".repeat(40), 32, "?")).toHaveLength(64); // 32 code points
    });

    it("falls back when nothing printable remains", () => {
        expect(sanitizeLabel("", 32, "CBER44PS")).toBe("CBER44PS");
        expect(sanitizeLabel("\u0000\u001b   ", 32, "CBER44PS")).toBe("CBER44PS");
        expect(sanitizeLabel(undefined, 32, "CBER44PS")).toBe("CBER44PS");
    });
});
