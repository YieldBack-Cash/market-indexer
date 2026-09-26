// Keeps src/protocol/ a byte-identical copy of the master in the contracts
// repo (ybc-contracts/protocol: protocol.ts and the parity fixtures).
//
//   npm run sync:protocol            copy the master over the local copy
//   npm run check:protocol           exit 1 if the local copy has drifted
//
// The master lives beside the Rust it mirrors, so the sibling checkout is
// needed (override with YBC_CONTRACTS_DIR). Without it the check reports
// nothing to compare against and exits 0; the vendored copy is then what runs.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CONTRACTS_DIR = resolve(__dirname, process.env.YBC_CONTRACTS_DIR ?? "../../../ybc-contracts");
export const MASTER = resolve(CONTRACTS_DIR, "protocol");
export const LOCAL = resolve(__dirname, "../protocol");

export const FILES = ["protocol.ts", "fixtures/pt_exchange_rate.json", "fixtures/yt_pending_yield.json"];

export const masterPresent = (): boolean => FILES.every((f) => existsSync(resolve(MASTER, f)));

/** The files whose local copy differs from the master, or is missing. */
export function drifted(): string[] {
    return FILES.filter((f) => {
        const local = resolve(LOCAL, f);
        return !existsSync(local) || readFileSync(local, "utf8") !== readFileSync(resolve(MASTER, f), "utf8");
    });
}

export function sync(): void {
    for (const f of FILES) {
        const target = resolve(LOCAL, f);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(MASTER, f), target);
    }
}

if (require.main === module) {
    if (!masterPresent()) {
        console.log(`no master at ${MASTER}; nothing to compare, the vendored copy stands`);
        process.exit(0);
    }
    if (process.argv.includes("--check")) {
        const stale = drifted();
        if (stale.length) {
            console.error(`src/protocol has drifted from ${MASTER}: ${stale.join(", ")}; run npm run sync:protocol`);
            process.exit(1);
        }
        console.log("src/protocol matches the master");
    } else {
        sync();
        console.log(`copied ${FILES.length} files from ${MASTER}`);
    }
}
