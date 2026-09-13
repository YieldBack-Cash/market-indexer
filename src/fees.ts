// Realized LP fee APY for one pool, from indexed trade events.
//
// Pools built from AMM wasm with the trade-fee event fields emit `fee` and
// `reserve_fee` (vault shares) on every trade; LPs keep `fee - reserve_fee`.
// Pools from older wasm emit neither, and get no figure: a blank is honest,
// a reconstructed estimate would not be.

export const TRADE_KINDS = [
    "swap_v_for_pt",
    "swap_pt_for_v",
    "flash_swap_pt",
    "flash_swap_v",
] as const;

// Every event whose payload carries post-event reserves.
export const RESERVE_KINDS = [...TRADE_KINDS, "deposit", "withdraw"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const APY_WINDOW_MS = 7 * DAY_MS;
// A pool a few minutes into its first trades would annualize one fee into an
// absurd APY, so the window never counts as shorter than a day.
const MIN_WINDOW_MS = DAY_MS;
const YEAR_SECS = 365 * 24 * 60 * 60;
const SCALE = 1e7;

export type FeeTrade = {
    at: Date;
    // Vault shares; undefined on events from pre-fee-field wasm.
    fee?: bigint;
    reserveFee?: bigint;
};

export type LpFeeApyInput = {
    now: Date;
    maturity: bigint; // unix seconds
    // The pool's first trade ever: tells whether it emits fees at all, and how
    // much history the window really has.
    firstTrade: FeeTrade | null;
    // Trades at or after now - APY_WINDOW_MS.
    windowTrades: FeeTrade[];
    // Post-event reserves from the latest reserve-moving event: PT, vault shares.
    reserveA: bigint | null;
    reserveB: bigint | null;
    // Latest implied rate, 1e7-scaled ln-space: PT exchange rate = e^(rate * years).
    impliedRate: bigint | null;
    // Vault assets per share (VaultRateSnapshot.rate).
    vaultRate: number | null;
};

// 1e7-scaled simple (not compounded) APY, or null when there is nothing honest
// to report.
export function computeLpFeeApy(input: LpFeeApyInput): bigint | null {
    const { now, maturity, firstTrade, windowTrades } = input;
    const { reserveA, reserveB, impliedRate, vaultRate } = input;

    const secsToExpiry = Number(maturity) - now.getTime() / 1000;
    if (secsToExpiry <= 0) return null;
    if (firstTrade === null || firstTrade.fee === undefined) return null;
    if (reserveA === null || reserveB === null || impliedRate === null) return null;
    if (vaultRate === null || vaultRate <= 0) return null;

    let lpFees = 0n;
    for (const t of windowTrades) {
        if (t.fee === undefined) continue;
        lpFees += t.fee - (t.reserveFee ?? 0n);
    }

    // PT redeems 1 asset at maturity, so it's worth e^(-rate * years) assets now.
    const years = secsToExpiry / YEAR_SECS;
    const ptPriceAssets = Math.exp((-Number(impliedRate) / SCALE) * years);
    const tvlShares = Number(reserveB) + (Number(reserveA) * ptPriceAssets) / vaultRate;
    if (!(tvlShares > 0)) return null;

    const history = now.getTime() - firstTrade.at.getTime();
    const windowMs = Math.max(MIN_WINDOW_MS, Math.min(APY_WINDOW_MS, history));

    const apy = (Number(lpFees) / tvlShares) * ((365 * DAY_MS) / windowMs);
    return BigInt(Math.round(apy * SCALE));
}
