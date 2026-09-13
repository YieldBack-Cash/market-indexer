import { describe, it, expect } from "vitest";
import { computeLpFeeApy, LpFeeApyInput } from "./fees";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-13T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);

// One year to expiry, zero implied rate (PT worth 1 asset), vault rate 1:
// TVL is simply reserveA + reserveB = 2000 shares.
function input(overrides: Partial<LpFeeApyInput> = {}): LpFeeApyInput {
    return {
        now,
        maturity: BigInt(now.getTime() / 1000 + 365 * 24 * 60 * 60),
        firstTrade: { at: daysAgo(30), fee: 1n, reserveFee: 0n },
        windowTrades: [
            { at: daysAgo(3), fee: 10n, reserveFee: 2n },
            { at: daysAgo(1), fee: 6n, reserveFee: 0n },
        ],
        reserveA: 1000n,
        reserveB: 1000n,
        impliedRate: 0n,
        vaultRate: 1,
        ...overrides,
    };
}

describe("computeLpFeeApy", () => {
    it("annualizes the LP share of a full 7-day window", () => {
        // LP fees 8 + 6 = 14; 14 / 2000 * 365 / 7 = 0.365
        expect(computeLpFeeApy(input())).toBe(3_650_000n);
    });

    it("annualizes over the real history when the pool is younger than 7 days", () => {
        // 20 / 2000 * 365 / 2 = 1.825
        const trade = { at: daysAgo(2), fee: 20n, reserveFee: 0n };
        expect(
            computeLpFeeApy(input({ firstTrade: trade, windowTrades: [trade] })),
        ).toBe(18_250_000n);
    });

    it("never annualizes over less than a day", () => {
        // First trade an hour ago still counts as a 1-day window: 20 / 2000 * 365
        const trade = { at: new Date(now.getTime() - 3_600_000), fee: 20n, reserveFee: 0n };
        expect(
            computeLpFeeApy(input({ firstTrade: trade, windowTrades: [trade] })),
        ).toBe(36_500_000n);
    });

    it("values PT reserves at the implied rate and vault rate", () => {
        // 10% implied APY for a year: PT worth 1/1.1 assets = 1/2.2 shares at rate 2.
        const apy = computeLpFeeApy(
            input({
                impliedRate: BigInt(Math.round(Math.log(1.1) * 1e7)),
                vaultRate: 2,
            }),
        );
        const tvl = 1000 + 1000 / 1.1 / 2;
        expect(Number(apy) / 1e7).toBeCloseTo((14 / tvl) * (365 / 7), 5);
    });

    it("is zero for a fee-emitting pool with no trades in the window", () => {
        expect(computeLpFeeApy(input({ windowTrades: [] }))).toBe(0n);
    });

    it("is null for pools whose events carry no fee (older AMM wasm)", () => {
        expect(
            computeLpFeeApy(input({ firstTrade: { at: daysAgo(30) } })),
        ).toBeNull();
    });

    it("is null for a pool that has never traded", () => {
        expect(computeLpFeeApy(input({ firstTrade: null }))).toBeNull();
    });

    it("is null once the market has expired", () => {
        expect(
            computeLpFeeApy(input({ maturity: BigInt(now.getTime() / 1000 - 1) })),
        ).toBeNull();
    });

    it("is null without a vault rate", () => {
        expect(computeLpFeeApy(input({ vaultRate: null }))).toBeNull();
    });
});
