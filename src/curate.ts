import "dotenv/config";
import { PrismaClient, Market } from "@prisma/client";
import {
    setListed,
    isNotFound,
    setVaultMetadata,
    parseVaultMetadata,
    VAULT_FIELDS,
} from "./curation";

const prisma = new PrismaClient();

const USAGE = `Usage:
  npm run curate -- pending                  markets awaiting review
  npm run curate -- listed                   markets live on the frontend
  npm run curate -- approve <marketId> [note]
  npm run curate -- hide    <marketId> [note]

  npm run curate -- vaults                   all vaults + missing metadata
  npm run curate -- vault <address>          one vault's full metadata
  npm run curate -- vault-set <address> <field> <value>

  vault fields: ${VAULT_FIELDS.join(", ")}
`;

function printMarkets(markets: Market[]) {
    if (markets.length === 0) {
        console.log("(none)");
        return;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const m of markets) {
        const state = m.maturity > now ? "active " : "matured";
        const created = m.createdAt.toISOString().slice(0, 10);
        console.log(
            `  [${state}] ${m.id}\n      name=${m.name} vault=${m.vault} maturity=${m.maturity} created=${created}` +
                (m.curationNote ? `\n      note: ${m.curationNote}` : ""),
        );
    }
    console.log(`\n${markets.length} market(s)`);
}

async function main() {
    const [command, id, ...noteParts] = process.argv.slice(2);
    const note = noteParts.length > 0 ? noteParts.join(" ") : undefined;

    switch (command) {
        case "pending":
        case "listed": {
            const markets = await prisma.market.findMany({
                where: { listed: command === "listed" },
                orderBy: { createdAt: "desc" },
            });
            printMarkets(markets);
            return 0;
        }

        case "approve":
        case "hide": {
            if (!id) {
                console.error(`${command} needs a market id\n\n${USAGE}`);
                return 1;
            }

            const listed = command === "approve";
            try {
                const market = await setListed(prisma, id, listed, note);
                console.log(
                    `${listed ? "listed" : "hidden"}: ${market.id} (${market.name})`,
                );
                return 0;
            } catch (err) {
                if (isNotFound(err)) {
                    console.error(`no market with id ${id}`);
                    return 1;
                }
                throw err;
            }
        }

        case "vaults": {
            const vaults = await prisma.vault.findMany({
                orderBy: { createdAt: "desc" },
                include: { _count: { select: { markets: true } } },
            });

            if (vaults.length === 0) {
                console.log("(none)");
                return 0;
            }

            for (const v of vaults) {
                const missing = VAULT_FIELDS.filter((f) => !v[f]);
                const state = missing.length === 0 ? "complete  " : "incomplete";
                console.log(
                    `  [${state}] ${v.address}\n      ${v.displayName ?? "(no display name)"} · ${v.protocolName ?? "(no protocol)"} · underlying=${v.underlyingSymbol ?? "?"} · markets=${v._count.markets}` +
                        (missing.length > 0
                            ? `\n      missing: ${missing.join(", ")}`
                            : ""),
                );
            }
            console.log(`\n${vaults.length} vault(s)`);
            return 0;
        }

        case "vault": {
            if (!id) {
                console.error(`vault needs an address\n\n${USAGE}`);
                return 1;
            }

            const vault = await prisma.vault.findUnique({
                where: { address: id },
            });
            if (!vault) {
                console.error(`no vault with address ${id}`);
                return 1;
            }

            console.log(`  ${vault.address}`);
            console.log(`  indexed from chain:`);
            for (const f of ["underlyingSymbol", "underlyingAsset", "pool"]) {
                console.log(`      ${f.padEnd(17)} ${vault[f] ?? "—"}`);
            }
            console.log(`  curated:`);
            for (const f of VAULT_FIELDS) {
                console.log(`      ${f.padEnd(17)} ${vault[f] ?? "—"}`);
            }
            console.log(
                `  curatedAt=${vault.curatedAt?.toISOString() ?? "—"}` +
                    (vault.curationNote ? `\n  note: ${vault.curationNote}` : ""),
            );
            return 0;
        }

        case "vault-set": {
            const [field, ...valueParts] = noteParts;
            if (!id || !field || valueParts.length === 0) {
                console.error(
                    `vault-set needs <address> <field> <value>\n\n${USAGE}`,
                );
                return 1;
            }

            // Reuse the HTTP route's validator so both surfaces enforce the
            // same field names and length caps.
            const parsed = parseVaultMetadata({
                [field]: valueParts.join(" "),
            });
            if (!parsed.ok) {
                console.error(parsed.error);
                return 1;
            }

            try {
                await setVaultMetadata(prisma, id, parsed.value);
                console.log(`${id}: set ${field}`);
                return 0;
            } catch (err) {
                if (isNotFound(err)) {
                    console.error(`no vault with address ${id}`);
                    return 1;
                }
                throw err;
            }
        }

        default:
            console.error(USAGE);
            return 1;
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
