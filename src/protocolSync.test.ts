// src/protocol is a vendored copy of ybc-contracts/protocol. When that repo is
// checked out beside this one, the copy must match it byte for byte; a drift
// means someone edited a copy, or forgot `npm run sync:protocol` after editing
// the master. Without the sibling there is nothing to compare against.
import { describe, expect, it } from "vitest";
import { MASTER, drifted, masterPresent } from "./spec/syncProtocol";

describe.skipIf(!masterPresent())(`src/protocol matches ${MASTER}`, () => {
    it("has no drifted files (else: npm run sync:protocol)", () => {
        expect(drifted()).toEqual([]);
    });
});
