import { describe, expect, it } from "vitest";
import { limitParam, MAX_LIMIT } from "./params";

describe("limitParam", () => {
    it("takes the fallback when absent", () => {
        expect(limitParam(undefined, 200)).toBe(200);
    });

    it("accepts a whole number within range", () => {
        expect(limitParam("1", 200)).toBe(1);
        expect(limitParam("37", 200)).toBe(37);
        expect(limitParam(String(MAX_LIMIT), 200)).toBe(MAX_LIMIT);
    });

    it("rejects zero, negatives, fractions, words, arrays and anything over the cap", () => {
        for (const bad of ["0", "-5", "2.5", "1e3", "abc", "", " 5", "5 ", String(MAX_LIMIT + 1), "99999"]) {
            expect(limitParam(bad, 200), JSON.stringify(bad)).toBeNull();
        }
        expect(limitParam(["5"], 200)).toBeNull(); // ?limit=5&limit=5
        expect(limitParam({ a: "5" }, 200)).toBeNull(); // ?limit[a]=5
    });
});
