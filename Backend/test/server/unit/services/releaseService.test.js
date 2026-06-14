"use strict";

/**
 * @fileoverview Unit tests for ReleaseService — the read-only release-train
 * state + draft builder. ChangelogModel.listAll is stubbed with Sinon so the
 * derivation runs against an in-memory list with no encrypted-store I/O.
 *
 * ReleaseService never writes: it reports the in-flight target and the draft
 * entry each available action would seed into the create form. Entries are
 * persisted through the normal changelog create path (single write path).
 */

const { expect } = require("chai");
const sinon = require("sinon");

const ReleaseService = require("../../../../src/services/ReleaseService");
const ChangelogModel = require("../../../../src/models/changelog.model");

describe("ReleaseService — release-train state + drafts (read-only)", function () {
    afterEach(() => sinon.restore());

    /** Stubs the store with bare version strings. */
    function seed(...versions) {
        const store = versions.map((v, i) => ({
            id: `s${i}`,
            version: v,
            displayDate: "2026-06-09",
            createdAt: `2026-06-09T00:00:0${i}.000Z`,
        }));
        sinon.stub(ChangelogModel, "listAll").returns(store);
    }

    // ─── target derivation ──────────────────────────────────────────────────────

    describe("target derivation", function () {
        it("reports no target on an empty store and offers an open cycle", function () {
            seed();
            const s = ReleaseService.getState();
            expect(s.hasTarget).to.be.false;
            expect(s.nextActions).to.deep.equal(["open"]);
            expect(s.drafts.open.minor.version).to.equal("0.1.0-dev.1");
            expect(s.drafts.content).to.be.null;
        });

        it("derives the highest-precedence version as the in-flight target", function () {
            seed("1.17.12-dev.1", "1.18.0-dev.2", "1.18.1-dev.1", "1.18.0-rc.1");
            const s = ReleaseService.getState();
            expect(s.version).to.equal("1.18.1-dev.1");
            expect(s.core).to.equal("1.18.1");
            expect(s.stage).to.equal("dev");
        });
    });

    // ─── promote drafts ───────────────────────────────────────────────────────────

    describe("promote drafts", function () {
        it("offers promote dev → alpha.1 and a same-stage content build", function () {
            seed("1.18.1-dev.3");
            const s = ReleaseService.getState();
            expect(s.nextActions).to.deep.equal(["promote"]);
            expect(s.drafts.promote.version).to.equal("1.18.1-alpha.1");
            expect(s.drafts.promote.type).to.equal("release");
            expect(s.drafts.content.version).to.equal("1.18.1-dev.4");
            expect(s.drafts.content.type).to.equal("feat");
            expect(s.drafts.cut).to.be.null;
            expect(s.drafts.open).to.be.null;
        });

        it("promotes alpha → beta and beta → rc", function () {
            seed("1.18.1-alpha.2");
            expect(ReleaseService.getState().drafts.promote.version).to.equal("1.18.1-beta.1");
            sinon.restore();
            seed("1.18.1-beta.1");
            expect(ReleaseService.getState().drafts.promote.version).to.equal("1.18.1-rc.1");
        });
    });

    // ─── cut drafts ───────────────────────────────────────────────────────────────

    describe("cut drafts", function () {
        it("offers cut rc → stable (bare core) plus a content build", function () {
            seed("1.18.1-rc.2");
            const s = ReleaseService.getState();
            expect(s.nextActions).to.deep.equal(["cut"]);
            expect(s.drafts.cut.version).to.equal("1.18.1");
            expect(s.drafts.cut.stage).to.equal("stable");
            expect(s.drafts.content.version).to.equal("1.18.1-rc.3");
            expect(s.drafts.promote).to.be.null;
        });
    });

    // ─── open drafts ──────────────────────────────────────────────────────────────

    describe("open drafts", function () {
        it("offers patch / minor / major cycles off a stable release", function () {
            seed("1.18.1");
            const s = ReleaseService.getState();
            expect(s.stage).to.equal("stable");
            expect(s.nextActions).to.deep.equal(["open"]);
            expect(s.drafts.open.patch.version).to.equal("1.18.2-dev.1");
            expect(s.drafts.open.minor.version).to.equal("1.19.0-dev.1");
            expect(s.drafts.open.major.version).to.equal("2.0.0-dev.1");
            expect(s.drafts.content).to.be.null; // no content until a cycle opens
            expect(s.drafts.promote).to.be.null;
        });
    });
});
