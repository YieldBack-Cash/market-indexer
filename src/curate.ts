import "dotenv/config";
import { userInfo } from "node:os";
import { PrismaClient, Market, Protocol } from "@prisma/client";
import {
    setListed,
    isNotFound,
    isAlreadyExists,
    isUnknownProtocol,
    isProtocolSlug,
    setVaultMetadata,
    parseVaultMetadata,
    VAULT_FIELDS,
    createProtocol,
    setProtocolMetadata,
    parseProtocolMetadata,
    PROTOCOL_FIELDS,
} from "./curation";

const prisma = new PrismaClient();

const USAGE = `Usage:
  npm run curate -- pending                  markets awaiting review
  npm run curate -- listed                   markets live on the frontend
  npm run curate -- approve <marketId> [note]
  npm run curate -- hide    <marketId> [note]

  npm run curate -- protocols                all protocols + missing metadata
  npm run curate -- protocol <id>            one protocol's full metadata
  npm run curate -- protocol-add <id> <name>
  npm run curate -- protocol-set <id> <field> <value>

  npm run curate -- vaults                   all vaults + missing metadata
  npm run curate -- vault <address>          one vault's full metadata
  npm run curate -- vault-set <address> <field> <value>

  protocol fields: ${PROTOCOL_FIELDS.join(", ")}
  vault fields:    ${VAULT_FIELDS.join(", ")}

  <id> is a slug you choose, versioned with the protocol: blendv2, xoxno.
`;

// Recorded as `curatedBy` on every write this CLI makes. The API records the
// curator whose key was used; here it is whoever is at the keyboard.
function curator(): string {
    return process.env.CURATOR || userInfo().username;
}

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

function printProtocolFields(p: Protocol, indent: string) {
    for (const f of PROTOCOL_FIELDS) {
        console.log(`${indent}${f.padEnd(13)} ${p[f] ?? "—"}`);
    }
}

function printCuration(row: { curatedAt: Date | null; curationNote: string | null; curatedBy: string | null }) {
    console.log(
        `  curatedAt=${row.curatedAt?.toISOString() ?? "—"} curatedBy=${row.curatedBy ?? "—"}` +
            (row.curationNote ? `\n  note: ${row.curationNote}` : ""),
    );
}

async function main() {
    const [command, id, ...rest] = process.argv.slice(2);
    const note = rest.length > 0 ? rest.join(" ") : undefined;

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
                const market = await setListed(prisma, id, listed, note, curator());
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

        case "protocols": {
            const protocols = await prisma.protocol.findMany({
                orderBy: { id: "asc" },
                include: { _count: { select: { vaults: true } } },
            });

            if (protocols.length === 0) {
                console.log("(none)");
                return 0;
            }

            for (const p of protocols) {
                const missing = PROTOCOL_FIELDS.filter((f) => !p[f]);
                const state = missing.length === 0 ? "complete  " : "incomplete";
                console.log(
                    `  [${state}] ${p.id}\n      ${p.name} · vaults=${p._count.vaults}` +
                        (missing.length > 0
                            ? `\n      missing: ${missing.join(", ")}`
                            : ""),
                );
            }
            console.log(`\n${protocols.length} protocol(s)`);
            return 0;
        }

        case "protocol": {
            if (!id) {
                console.error(`protocol needs an id\n\n${USAGE}`);
                return 1;
            }

            const protocol = await prisma.protocol.findUnique({
                where: { id },
                include: { vaults: { select: { address: true, displayName: true } } },
            });
            if (!protocol) {
                console.error(`no protocol with id ${id}`);
                return 1;
            }

            console.log(`  ${protocol.id}`);
            printProtocolFields(protocol, "      ");
            console.log(`  vaults:`);
            if (protocol.vaults.length === 0) console.log(`      (none)`);
            for (const v of protocol.vaults) {
                console.log(`      ${v.address}  ${v.displayName ?? "(no display name)"}`);
            }
            printCuration(protocol);
            return 0;
        }

        case "protocol-add": {
            if (!id || rest.length === 0) {
                console.error(`protocol-add needs <id> <name>\n\n${USAGE}`);
                return 1;
            }
            if (!isProtocolSlug(id)) {
                console.error(
                    `${id} is not a slug: lowercase letters, digits and dashes, e.g. blendv2`,
                );
                return 1;
            }

            const parsed = parseProtocolMetadata({ name: rest.join(" ") });
            if (!parsed.ok) {
                console.error(parsed.error);
                return 1;
            }

            try {
                await createProtocol(prisma, id, { name: parsed.value.name }, undefined, curator());
                console.log(`created protocol ${id}`);
                return 0;
            } catch (err) {
                if (isAlreadyExists(err)) {
                    console.error(`protocol ${id} already exists`);
                    return 1;
                }
                throw err;
            }
        }

        case "protocol-set": {
            const [field, ...valueParts] = rest;
            if (!id || !field || valueParts.length === 0) {
                console.error(
                    `protocol-set needs <id> <field> <value>\n\n${USAGE}`,
                );
                return 1;
            }

            const parsed = parseProtocolMetadata({
                [field]: valueParts.join(" "),
            });
            if (!parsed.ok) {
                console.error(parsed.error);
                return 1;
            }

            try {
                await setProtocolMetadata(prisma, id, parsed.value, undefined, curator());
                console.log(`${id}: set ${field}`);
                return 0;
            } catch (err) {
                if (isNotFound(err)) {
                    console.error(`no protocol with id ${id}`);
                    return 1;
                }
                throw err;
            }
        }

        case "vaults": {
            const vaults = await prisma.vault.findMany({
                orderBy: { createdAt: "desc" },
                include: { protocol: true, _count: { select: { markets: true } } },
            });

            if (vaults.length === 0) {
                console.log("(none)");
                return 0;
            }

            for (const v of vaults) {
                const missing = VAULT_FIELDS.filter((f) => !v[f]);
                const state = missing.length === 0 ? "complete  " : "incomplete";
                console.log(
                    `  [${state}] ${v.address}\n      ${v.displayName ?? "(no display name)"} · ${v.protocol?.name ?? "(no protocol)"} · underlying=${v.underlyingSymbol ?? "?"} · markets=${v._count.markets}` +
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
                include: { protocol: true },
            });
            if (!vault) {
                console.error(`no vault with address ${id}`);
                return 1;
            }

            console.log(`  ${vault.address}`);
            console.log(`  indexed from chain:`);
            for (const f of ["underlyingSymbol", "underlyingAsset", "pool"] as const) {
                console.log(`      ${f.padEnd(17)} ${vault[f] ?? "—"}`);
            }
            console.log(`  curated:`);
            for (const f of VAULT_FIELDS) {
                console.log(`      ${f.padEnd(17)} ${vault[f] ?? "—"}`);
            }
            if (vault.protocol) {
                console.log(`  protocol ${vault.protocol.id}:`);
                printProtocolFields(vault.protocol, "      ");
            }
            printCuration(vault);
            return 0;
        }

        case "vault-set": {
            const [field, ...valueParts] = rest;
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
                await setVaultMetadata(prisma, id, parsed.value, undefined, curator());
                console.log(`${id}: set ${field}`);
                return 0;
            } catch (err) {
                if (isNotFound(err)) {
                    console.error(`no vault with address ${id}`);
                    return 1;
                }
                if (isUnknownProtocol(err)) {
                    console.error(
                        `no protocol with id ${parsed.value.protocolId} — protocol-add it first`,
                    );
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
