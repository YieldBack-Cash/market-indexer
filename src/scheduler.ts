// The indexer's two schedules, in one process with no broker.
//
// This used to be two BullMQ repeat jobs on Redis. They ran one function every
// five seconds and another every hour; a queue adds nothing to that except a
// Redis to install, secure and keep up, and a second place a restart can be
// forgotten. Each schedule below is a loop: run, wait out the rest of the
// interval, run again. A failure is logged and the next tick still happens.
import "dotenv/config";
import { syncEvents, snapshotVaultRates, updateLpFeeApys } from "./indexer";

// Testnet closes a ledger every five to six seconds; polling faster than that
// only finds an unchanged tip, which `syncEvents` already skips cheaply.
const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5_000;
const SNAPSHOT_MS = 3_600_000;

let stopping = false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function every(name: string, intervalMs: number, task: () => Promise<void>): Promise<void> {
    while (!stopping) {
        const started = Date.now();
        try {
            await task();
        } catch (err) {
            console.error(`[${name} failed] ${err instanceof Error ? err.message : String(err)}`);
        }
        const remaining = intervalMs - (Date.now() - started);
        if (remaining > 0 && !stopping) await sleep(remaining);
    }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        // Finish the tick in flight, then let the loops fall out.
        stopping = true;
        console.log(`${signal} received; stopping after the current tick`);
    });
}

console.log(`YBC Indexer started — syncing events every ${POLL_MS / 1000}s, snapshotting rates hourly`);
Promise.all([
    every("sync", POLL_MS, syncEvents),
    every("snapshot", SNAPSHOT_MS, async () => {
        await snapshotVaultRates();
        // Right after the snapshot, so the APY uses the freshest vault rate.
        await updateLpFeeApys();
    }),
]).then(() => process.exit(0));
