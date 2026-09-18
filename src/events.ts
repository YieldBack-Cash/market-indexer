import { scValToNative } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

export interface Market {
    name?: string;
    ym: string;
    pt: string;
    yt: string;
    pool: string;
    maturity: bigint;
    vault: string;
}

export interface WasmHashes {
    pt: string;
    yt: string;
    ym: string;
    amm: string;
}

export type DecodedFactoryEvent =
    | { kind: "market_created"; vault: string; market: Market }
    | { kind: "admin_changed"; oldAdmin: string; newAdmin: string }
    | {
          kind: "wasm_hashes_updated";
          old_hashes: WasmHashes;
          new_hashes: WasmHashes;
      }
    | { kind: "contract_upgraded"; new_wasm_hash: string }
    | { kind: "fee_config_updated"; old_config: unknown; new_config: unknown };

export type DecodedYmEvent =
    | {
          kind: "token_contracts_set";
          pt: string;
          yt: string;
      }
    | {
          kind: "deposit";
          from: string;
          shares_amount: bigint;
          mint_amount: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "redeem_combined";
          from: string;
          amount: bigint;
          shares_returned: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "redeem_principal";
          from: string;
          pt_amount: bigint;
          shares_returned: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "distribute_yield";
          to: string;
          shares_amount: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "flash_deposit";
          user: string;
          amm: string;
          yt_out: bigint;
          v_to_mint: bigint;
          user_cost: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "flash_redeem";
          user: string;
          amm: string;
          pt_borrowed: bigint;
          v_owed: bigint;
          v_to_user: bigint;
          exchange_rate: bigint;
      }
    // The base-asset paths the app actually uses. deposit_asset is the router's
    // zap_asset_for_split (the Split form); redeem_to_asset is its
    // zap_split_for_asset (Combine, which burns PT and YT) and
    // exit_expired_to_asset (Redeem after maturity, which burns PT only). The
    // event doesn't say which redemption it was: the contract only allows a
    // combine before maturity and a principal redeem after, so the event's
    // time against the market's maturity does.
    | {
          kind: "deposit_asset";
          from: string;
          asset_in: bigint;
          shares_in: bigint;
          mint_amount: bigint;
          exchange_rate: bigint;
      }
    | {
          kind: "redeem_to_asset";
          from: string;
          burned: bigint;
          shares_redeemed: bigint;
          asset_out: bigint;
          exchange_rate: bigint;
      }
    | { kind: "pool_set"; pool: string }
    | { kind: "surplus_collected"; treasury: string; amount: bigint };

// Trailing fields on every AMM trade event, in vault shares: the whole trading
// fee and the treasury's cut of it (LPs keep the difference). Pools deployed
// from AMM wasm older than these fields omit both, so they stay optional.
export type TradeFees = { fee?: bigint; reserve_fee?: bigint };

// The fields sit after the fixed ones, so the same positional decode reads both
// old and new event shapes: on an old shape the two slots are just past the end.
function tradeFees(value: bigint[], offset: number): TradeFees {
    return value.length > offset + 1
        ? { fee: value[offset], reserve_fee: value[offset + 1] }
        : {};
}

export type DecodedAMMEvent =
    | {
          kind: "pool_init";
          token_a: string;
          token_b: string;
          expiry_ts: bigint;
          // Creator-supplied market params, 1e7-scaled APYs.
          current_apy: bigint;
          apy_min: bigint;
          apy_max: bigint;
          fee_apy: bigint;
          // Curve params derived from them.
          scalar_root: bigint;
          fee_rate_root: bigint;
          last_implied_rate: bigint;
          treasury: string;
          reserve_fee_rate: bigint;
      }
    | ({
          kind: "swap_v_for_pt";
          to: string;
          v_in: bigint;
          pt_out: bigint;
          new_implied_rate: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      } & TradeFees)
    | ({
          kind: "swap_pt_for_v";
          to: string;
          pt_in: bigint;
          v_out: bigint;
          new_implied_rate: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      } & TradeFees)
    | ({
          kind: "flash_swap_pt";
          receiver: string;
          user: string;
          pt_bought: bigint;
          v_paid: bigint;
          new_implied_rate: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      } & TradeFees)
    | ({
          kind: "flash_swap_v";
          receiver: string;
          user: string;
          pt_borrowed: bigint;
          v_owed: bigint;
          new_implied_rate: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      } & TradeFees)
    | {
          kind: "deposit";
          to: string;
          amount_a: bigint;
          amount_b: bigint;
          shares_minted: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      }
    | {
          kind: "withdraw";
          to: string;
          share_amount: bigint;
          amount_a: bigint;
          amount_b: bigint;
          new_reserve_a: bigint;
          new_reserve_b: bigint;
      }
    | {
          kind: "reserve_fee_paid";
          treasury: string;
          amount: bigint;
      };

export function decodeYmEvent(raw: rpc.Api.EventResponse): DecodedYmEvent {
    const topics = raw.topic.map(scValToNative);
    const value = scValToNative(raw.value) as bigint[];

    switch (topics[0] as string) {
        case "token_contracts_set": {
            return {
                kind: "token_contracts_set",
                pt: topics[1],
                yt: topics[2],
            };
        }
        case "deposit": {
            const [shares_amount, mint_amount, exchange_rate] = value;
            return {
                kind: "deposit",
                from: topics[1],
                shares_amount,
                mint_amount,
                exchange_rate,
            };
        }
        case "redeem_combined": {
            const [amount, shares_returned, exchange_rate] = value;
            return {
                kind: "redeem_combined",
                from: topics[1],
                amount,
                shares_returned,
                exchange_rate,
            };
        }
        case "redeem_principal": {
            const [pt_amount, shares_returned, exchange_rate] = value;
            return {
                kind: "redeem_principal",
                from: topics[1],
                pt_amount,
                shares_returned,
                exchange_rate,
            };
        }
        case "distribute_yield": {
            const [shares_amount, exchange_rate] = value;
            return {
                kind: "distribute_yield",
                to: topics[1],
                shares_amount,
                exchange_rate,
            };
        }
        case "flash_deposit": {
            const [yt_out, v_to_mint, user_cost, exchange_rate] = value;
            return {
                kind: "flash_deposit",
                user: topics[1],
                amm: topics[2],
                yt_out,
                v_to_mint,
                user_cost,
                exchange_rate,
            };
        }
        case "flash_redeem": {
            const [pt_borrowed, v_owed, v_to_user, exchange_rate] = value;
            return {
                kind: "flash_redeem",
                user: topics[1],
                amm: topics[2],
                pt_borrowed,
                v_owed,
                v_to_user,
                exchange_rate,
            };
        }
        case "deposit_asset": {
            const [asset_in, shares_in, mint_amount, exchange_rate] = value;
            return {
                kind: "deposit_asset",
                from: topics[1],
                asset_in,
                shares_in,
                mint_amount,
                exchange_rate,
            };
        }
        case "redeem_to_asset": {
            const [burned, shares_redeemed, asset_out, exchange_rate] = value;
            return {
                kind: "redeem_to_asset",
                from: topics[1],
                burned,
                shares_redeemed,
                asset_out,
                exchange_rate,
            };
        }
        // Setup and treasury bookkeeping: nothing a wallet did, but decoding
        // them keeps them out of the skipped-event log, where they would bury
        // a genuinely unknown event.
        case "pool_set":
            return { kind: "pool_set", pool: topics[1] };
        case "surplus_collected": {
            const [amount] = value;
            return { kind: "surplus_collected", treasury: topics[1], amount };
        }
        default:
            throw new Error(`Unknown YM Event: ${topics[0]}`);
    }
}

export function decodeAMMEvent(raw: rpc.Api.EventResponse): DecodedAMMEvent {
    const topics = raw.topic.map(scValToNative);
    const name = topics[0] as string;

    if (name === "pool_init") {
        // Map-shaped data (not vec), so fields are read by name.
        const val = scValToNative(raw.value) as Omit<
            Extract<DecodedAMMEvent, { kind: "pool_init" }>,
            "kind" | "token_a" | "token_b"
        >;
        return {
            kind: "pool_init",
            token_a: topics[1],
            token_b: topics[2],
            ...val,
        };
    }

    const value = scValToNative(raw.value) as bigint[];
    switch (name) {
        case "swap_v_for_pt": {
            const [
                v_in,
                pt_out,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "swap_v_for_pt",
                to: topics[1],
                v_in,
                pt_out,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
                ...tradeFees(value, 5),
            };
        }
        case "swap_pt_for_v": {
            const [
                pt_in,
                v_out,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "swap_pt_for_v",
                to: topics[1],
                pt_in,
                v_out,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
                ...tradeFees(value, 5),
            };
        }
        case "flash_swap_pt": {
            const [
                pt_bought,
                v_paid,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "flash_swap_pt",
                receiver: topics[1],
                user: topics[2],
                pt_bought,
                v_paid,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
                ...tradeFees(value, 5),
            };
        }
        case "flash_swap_v": {
            const [
                pt_borrowed,
                v_owed,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "flash_swap_v",
                receiver: topics[1],
                user: topics[2],
                pt_borrowed,
                v_owed,
                new_implied_rate,
                new_reserve_a,
                new_reserve_b,
                ...tradeFees(value, 5),
            };
        }
        case "deposit": {
            const [
                amount_a,
                amount_b,
                shares_minted,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "deposit",
                to: topics[1],
                amount_a,
                amount_b,
                shares_minted,
                new_reserve_a,
                new_reserve_b,
            };
        }
        case "withdraw": {
            const [
                share_amount,
                amount_a,
                amount_b,
                new_reserve_a,
                new_reserve_b,
            ] = value;
            return {
                kind: "withdraw",
                to: topics[1],
                share_amount,
                amount_a,
                amount_b,
                new_reserve_a,
                new_reserve_b,
            };
        }
        case "reserve_fee_paid": {
            const [amount] = value;
            return { kind: "reserve_fee_paid", treasury: topics[1], amount };
        }
        default:
            throw new Error(`Unknown AMM event: ${name}`);
    }
}

export function decodeFactoryEvent(
    raw: rpc.Api.EventResponse,
): DecodedFactoryEvent {
    const topics = raw.topic.map(scValToNative);
    const value = scValToNative(raw.value);
    const eventName = topics[0] as string;

    switch (eventName) {
        case "market_created": {
            // The vault comes from the event's data, not a topic. MarketCreated
            // gained a `creator` topic ahead of `vault`, which silently shifted
            // topics[1] from the vault to the creator and keyed whole markets
            // under an account address. The data payload carries `vault` in
            // both the old and new event shapes, so it cannot drift again.
            const market = value as Market;
            return {
                kind: "market_created",
                vault: market.vault,
                market,
            };
        }
        case "admin_changed":
            return {
                kind: "admin_changed",
                oldAdmin: value.old_admin,
                newAdmin: value.new_admin,
            };
        case "wasm_hashes_updated":
            return {
                kind: "wasm_hashes_updated",
                old_hashes: value.old_hashes,
                new_hashes: value.new_hashes,
            };
        case "contract_upgraded":
            return {
                kind: "contract_upgraded",
                new_wasm_hash: value.new_wasm_hash,
            };
        case "fee_config_updated":
            return {
                kind: "fee_config_updated",
                old_config: value.old_config,
                new_config: value.new_config,
            };
        default:
            throw new Error(`Unknown factory event: ${eventName}`);
    }
}
