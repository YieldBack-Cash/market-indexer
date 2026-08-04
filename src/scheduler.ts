import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { syncEvents, snapshotVaultRates } from "./indexer";

const connection = {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
};

const queue = new Queue("ybc-indexer", { connection });
const snapshotQueue = new Queue("ybc-snapshot", { connection });

const worker = new Worker(
    "ybc-indexer",
    async () => {
        await syncEvents();
    },
    {
        connection,
    },
);

worker.on("failed", (job, err) => {
    console.error(`[sync failed] ${err.message}`);
});

const snapshotWorker = new Worker(
    "ybc-snapshot",
    async () => {
        await snapshotVaultRates();
    },
    { connection },
);

snapshotWorker.on("failed", (job, err) => {
    console.error(`[snapshot failed] ${err.message}`);
});

async function start() {
    await queue.add(
        "sync",
        {},
        {
            repeat: { every: 5_000 },
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
        },
    );

    await snapshotQueue.add(
        "snapshot",
        {},
        {
            repeat: { every: 3_600_000 },
            removeOnComplete: true,
        },
    );

    console.log("YBC Indexer started — syncing factory events every 5s");
}

start();
