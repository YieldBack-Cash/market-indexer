// Pure helpers for the sync loop, kept apart from indexer.ts so they can be
// tested without a database client in the way.

/**
 * How many ledgers the poller's cursor trails the RPC's oldest retained ledger.
 * Zero means every ledger from the cursor on is still fetchable; anything more
 * is history this RPC no longer has.
 */
export function retentionGap(startLedger: number, oldestLedger: number): number {
    return Math.max(0, oldestLedger - startLedger);
}

/**
 * The display name for a market: the factory's own (`bvXLM-23DEC2026`), or, for
 * factories from before the name was part of the event, the vault's underlying
 * symbol and the maturity date.
 */
export function marketNameFor(
    market: { name?: string; maturity: bigint },
    vault: string,
    vaultSymbol: string | undefined,
): string {
    if (market.name) return market.name;
    const maturityDate = new Date(Number(market.maturity) * 1000).toISOString().slice(0, 10);
    return `${vaultSymbol ?? vault.slice(0, 8)}-${maturityDate}`;
}

/**
 * A string a contract supplied (a token symbol, a market name), made safe to
 * store, serve and print: control, format, surrogate and private-use
 * characters removed, whitespace collapsed, and cut to `max` characters. A
 * hostile vault can still choose its symbol; it cannot smuggle a terminal
 * escape or a bidi override into the curator's screen, or a megabyte into a
 * row. Returns `fallback` when nothing printable is left.
 */
export function sanitizeLabel(raw: string | undefined, max: number, fallback: string): string {
    if (raw === undefined) return fallback;
    // Whitespace first, so a tab or a line break becomes a space rather than
    // vanishing and gluing two words together.
    const cleaned = raw
        .replace(/\s+/g, " ")
        .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, "")
        .trim();
    if (cleaned.length === 0) return fallback;
    return Array.from(cleaned).slice(0, max).join("");
}

/** The longest symbol and market name the indexer will store. */
export const MAX_SYMBOL_CHARS = 32;
export const MAX_NAME_CHARS = 64;
