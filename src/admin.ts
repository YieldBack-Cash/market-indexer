import express, { Router, Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import {
    setListed,
    isNotFound,
    isAlreadyExists,
    isUnknownProtocol,
    isProtocolSlug,
    parseVaultMetadata,
    setVaultMetadata,
    parseProtocolMetadata,
    createProtocol,
    setProtocolMetadata,
} from "./curation";

const MAX_NOTE_LENGTH = 500;

// Fails closed: with no ADMIN_API_KEY configured the admin surface is disabled
// outright rather than left open.
function requireAdminKey(req: Request, res: Response, next: NextFunction) {
    const expected = process.env.ADMIN_API_KEY;
    if (!expected) {
        return res.status(503).json({ error: "admin API not configured" });
    }

    const provided = req.get("x-admin-key") ?? "";
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch, so check that first. The
    // length itself leaks, which is acceptable for a random shared secret.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return res.status(401).json({ error: "unauthorized" });
    }

    next();
}

function toAdminJson(row: Record<string, unknown>) {
    // Curation notes stay on this side of the wall, but BigInt still needs
    // stringifying before res.json touches it.
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
        ]),
    );
}

// `note` rides along on every curation write. Returns the 400 message, or
// null when the note is absent or acceptable.
function noteError(note: unknown): string | null {
    if (note === undefined) return null;
    if (typeof note !== "string") return "`note` must be a string";
    if (note.length > MAX_NOTE_LENGTH) {
        return `\`note\` exceeds ${MAX_NOTE_LENGTH} chars`;
    }
    return null;
}

export function adminRouter(prisma: PrismaClient): Router {
    const router = Router();

    // The public limiter (60/min) would throttle a bulk curation session; this
    // surface is key-gated, so it gets its own, looser budget.
    router.use(rateLimit({ windowMs: 60_000, max: 300 }));
    router.use(requireAdminKey);
    router.use(express.json({ limit: "16kb" }));

    // Review queue. Returns expired markets too — something can mature while
    // it is still sitting unreviewed.
    router.get("/markets", async (req, res) => {
        const { listed } = req.query;
        const where =
            listed === undefined ? {} : { listed: listed !== "false" };

        const markets = await prisma.market.findMany({
            where,
            orderBy: { createdAt: "desc" },
        });

        res.json(markets.map(toAdminJson));
    });

    router.patch("/markets/:id", async (req, res) => {
        const { listed, note } = req.body ?? {};

        if (typeof listed !== "boolean") {
            return res
                .status(400)
                .json({ error: "`listed` must be a boolean" });
        }
        const badNote = noteError(note);
        if (badNote) return res.status(400).json({ error: badNote });

        try {
            const market = await setListed(prisma, req.params.id, listed, note);
            res.json(toAdminJson(market));
        } catch (err) {
            if (isNotFound(err)) {
                return res.status(404).json({ error: "market not found" });
            }
            throw err;
        }
    });

    router.get("/vaults", async (req, res) => {
        const vaults = await prisma.vault.findMany({
            orderBy: { createdAt: "desc" },
            include: { protocol: true },
        });

        res.json(vaults.map(toAdminJson));
    });

    router.patch("/vaults/:address", async (req, res) => {
        const parsed = parseVaultMetadata(req.body ?? {});
        if (!parsed.ok) {
            return res.status(400).json({ error: parsed.error });
        }

        const { note } = req.body ?? {};
        const badNote = noteError(note);
        if (badNote) return res.status(400).json({ error: badNote });

        try {
            const vault = await setVaultMetadata(
                prisma,
                req.params.address,
                parsed.value,
                note,
            );
            res.json(toAdminJson(vault));
        } catch (err) {
            if (isNotFound(err)) {
                return res.status(404).json({ error: "vault not found" });
            }
            if (isUnknownProtocol(err)) {
                return res.status(400).json({
                    error: `no protocol with id \`${parsed.value.protocolId}\` — create it first`,
                });
            }
            throw err;
        }
    });

    router.get("/protocols", async (_req, res) => {
        const protocols = await prisma.protocol.findMany({
            orderBy: { id: "asc" },
            include: { _count: { select: { vaults: true } } },
        });

        res.json(protocols.map(toAdminJson));
    });

    // Creation is its own verb rather than an upsert on PATCH, so a typo in
    // the slug is a 404 and not a silent second protocol.
    router.post("/protocols", async (req, res) => {
        const { id, note, ...fields } = req.body ?? {};

        if (typeof id !== "string" || !isProtocolSlug(id)) {
            return res.status(400).json({
                error: "`id` must be a slug: lowercase letters, digits and dashes, e.g. `blendv2`",
            });
        }
        const parsed = parseProtocolMetadata(fields);
        if (!parsed.ok) {
            return res.status(400).json({ error: parsed.error });
        }
        if (typeof parsed.value.name !== "string") {
            return res.status(400).json({ error: "`name` is required" });
        }
        const badNote = noteError(note);
        if (badNote) return res.status(400).json({ error: badNote });

        try {
            const protocol = await createProtocol(
                prisma,
                id,
                { ...parsed.value, name: parsed.value.name },
                note,
            );
            res.status(201).json(toAdminJson(protocol));
        } catch (err) {
            if (isAlreadyExists(err)) {
                return res
                    .status(409)
                    .json({ error: `protocol \`${id}\` already exists` });
            }
            throw err;
        }
    });

    router.patch("/protocols/:id", async (req, res) => {
        const parsed = parseProtocolMetadata(req.body ?? {});
        if (!parsed.ok) {
            return res.status(400).json({ error: parsed.error });
        }

        const { note } = req.body ?? {};
        const badNote = noteError(note);
        if (badNote) return res.status(400).json({ error: badNote });

        try {
            const protocol = await setProtocolMetadata(
                prisma,
                req.params.id,
                parsed.value,
                note,
            );
            res.json(toAdminJson(protocol));
        } catch (err) {
            if (isNotFound(err)) {
                return res.status(404).json({ error: "protocol not found" });
            }
            throw err;
        }
    });

    return router;
}
