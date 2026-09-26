// Regenerates src/eventLayouts.generated.ts from the contract binaries, so the
// indexer never types an event's field order.
//
//   npm run gen:events            rewrite the file
//   npm run check:events          exit 1 if the file is stale (for CI)
//
// Binaries come from the sibling ybc-contracts checkout's release build
// (override the checkout with YBC_CONTRACTS_DIR). Build them first with
// `stellar contract build`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eventsIn, renderModule } from "./contractSpec";

export const OUTPUT = resolve(__dirname, "../eventLayouts.generated.ts");
export const CONTRACTS_DIR = resolve(__dirname, process.env.YBC_CONTRACTS_DIR ?? "../../../ybc-contracts");

const RELEASE = "target/wasm32v1-none/release";

/** Where each table's binary lives, relative to the contracts checkout. */
export const SOURCES = {
    factory: `${RELEASE}/factory.wasm`,
    ym: `${RELEASE}/yield_manager.wasm`,
    amm: `${RELEASE}/amm.wasm`,
    router: `${RELEASE}/router.wasm`,
};

export function allBinariesPresent(dir = CONTRACTS_DIR): boolean {
    return Object.values(SOURCES).every((file) => existsSync(resolve(dir, file)));
}

/** The generated module's text, read fresh from the binaries. */
export function generate(dir = CONTRACTS_DIR): string {
    return renderModule(
        Object.entries(SOURCES).map(([constKey, source]) => ({
            constKey,
            source,
            events: eventsIn(readFileSync(resolve(dir, source))),
        })),
    );
}

if (require.main === module) {
    if (!allBinariesPresent()) {
        console.error(`missing contract binaries under ${CONTRACTS_DIR}; build them or set YBC_CONTRACTS_DIR`);
        process.exit(2);
    }
    const fresh = generate();
    if (process.argv.includes("--check")) {
        const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
        if (committed !== fresh) {
            console.error(`${OUTPUT} is stale; run npm run gen:events`);
            process.exit(1);
        }
        console.log("event layouts are up to date");
    } else {
        writeFileSync(OUTPUT, fresh);
        console.log(`wrote ${OUTPUT}`);
    }
}
