import { describe, expect, it } from "vitest";
import { matchAdminKey, parseAdminKeys } from "./adminKeys";

const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);

describe("parseAdminKeys", () => {
    it("reads one credential per curator", () => {
        expect(parseAdminKeys({ ADMIN_API_KEYS: `alice=${ALICE}, bob=${BOB}` })).toEqual([
            { curator: "alice", secret: ALICE },
            { curator: "bob", secret: BOB },
        ]);
    });

    it("keeps the old single key as the curator \"admin\"", () => {
        expect(parseAdminKeys({ ADMIN_API_KEY: ALICE })).toEqual([{ curator: "admin", secret: ALICE }]);
        expect(parseAdminKeys({ ADMIN_API_KEYS: `alice=${ALICE}`, ADMIN_API_KEY: BOB })).toEqual([
            { curator: "alice", secret: ALICE },
            { curator: "admin", secret: BOB },
        ]);
    });

    it("is empty when nothing is configured, so the admin surface fails closed", () => {
        expect(parseAdminKeys({})).toEqual([]);
        expect(parseAdminKeys({ ADMIN_API_KEYS: " , " })).toEqual([]);
    });

    it("refuses a malformed entry instead of skipping it", () => {
        expect(() => parseAdminKeys({ ADMIN_API_KEYS: ALICE })).toThrow(/name=secret/);
        expect(() => parseAdminKeys({ ADMIN_API_KEYS: `=${ALICE}` })).toThrow(/name=secret/);
        expect(() => parseAdminKeys({ ADMIN_API_KEYS: `al ice=${ALICE}` })).toThrow(/bad curator name/);
        expect(() => parseAdminKeys({ ADMIN_API_KEYS: "alice=short" })).toThrow(/too short/);
        expect(() => parseAdminKeys({ ADMIN_API_KEYS: `alice=${ALICE},alice=${BOB}` })).toThrow(/twice/);
    });
});

describe("matchAdminKey", () => {
    const keys = parseAdminKeys({ ADMIN_API_KEYS: `alice=${ALICE},bob=${BOB}` });

    it("names the curator whose secret was presented", () => {
        expect(matchAdminKey(keys, ALICE)).toBe("alice");
        expect(matchAdminKey(keys, BOB)).toBe("bob");
    });

    it("rejects anything else, including a near miss and an empty key", () => {
        expect(matchAdminKey(keys, "a".repeat(31) + "b")).toBeNull();
        expect(matchAdminKey(keys, ALICE + "\n")).toBeNull();
        expect(matchAdminKey(keys, "")).toBeNull();
        expect(matchAdminKey([], ALICE)).toBeNull();
    });
});
