"use strict";

/**
 * @fileoverview Unit tests for ChangelogService validation.
 *
 * ChangelogModel.create / update are stubbed with Sinon so validation runs with
 * no encrypted-store I/O and no env vars. Focus: the version-stage refactor —
 *   • the new "breaking" entry type is accepted
 *   • staged (pre-release) versions are accepted
 *   • garbage stage tags / unknown types / malformed cores are rejected (CWE-20)
 */

const { expect } = require("chai");
const sinon = require("sinon");

const ChangelogService = require("../../../../src/services/ChangelogService");
const ChangelogModel = require("../../../../src/models/changelog.model");

const base = {
    displayDate: "2026-06-09",
    version: "1.19.0",
    title: "Title",
    message: "Message",
    type: "feat",
};

describe("ChangelogService — validation (stage + breaking refactor)", function () {
    let createStub;

    beforeEach(() => {
        createStub = sinon.stub(ChangelogModel, "create").callsFake((d) => d);
    });

    afterEach(() => sinon.restore());

    // ─── type ──────────────────────────────────────────────────────────────────

    describe("type", function () {
        it("accepts the new 'breaking' type", function () {
            expect(() =>
                ChangelogService.create({ ...base, type: "breaking" }),
            ).to.not.throw();
            expect(createStub.calledOnce).to.be.true;
        });

        ["feat", "fix", "patch", "perf", "refactor", "security", "docs", "chore"].forEach(
            (t) => {
                it(`accepts existing type '${t}'`, function () {
                    expect(() =>
                        ChangelogService.create({ ...base, type: t }),
                    ).to.not.throw();
                });
            },
        );

        it("rejects an unknown type and never reaches the model", function () {
            expect(() => ChangelogService.create({ ...base, type: "wip" })).to.throw();
            expect(createStub.called).to.be.false;
        });
    });

    // ─── version (optional stage pre-release tag) ───────────────────────────────

    describe("version", function () {
        ["1.4.0", "1.19.0", "1.19.0-dev.1", "1.19.0-alpha.2", "1.19.0-beta.1", "1.19.0-rc.1"].forEach(
            (v) => {
                it(`accepts '${v}'`, function () {
                    expect(() =>
                        ChangelogService.create({ ...base, version: v }),
                    ).to.not.throw();
                });
            },
        );

        ["1.19.0-foo", "1.19.0-beta", "1.19", "v1.4.0", "1.0.0; DROP TABLE"].forEach((v) => {
            it(`rejects '${v}' and never reaches the model`, function () {
                expect(() =>
                    ChangelogService.create({ ...base, version: v }),
                ).to.throw();
                expect(createStub.called).to.be.false;
            });
        });
    });

    // ─── required fields ────────────────────────────────────────────────────────

    describe("required fields", function () {
        it("rejects a body missing required fields", function () {
            expect(() => ChangelogService.create({ version: "1.0.0" })).to.throw();
            expect(createStub.called).to.be.false;
        });
    });

    // ─── partial update ─────────────────────────────────────────────────────────

    describe("partial update", function () {
        it("accepts a staged version on update", function () {
            const updateStub = sinon
                .stub(ChangelogModel, "update")
                .callsFake((id, d) => d);
            expect(() =>
                ChangelogService.update("id-1", { version: "1.19.0-rc.1" }),
            ).to.not.throw();
            expect(updateStub.calledOnce).to.be.true;
        });

        it("rejects a garbage staged version on update", function () {
            sinon.stub(ChangelogModel, "update").callsFake((id, d) => d);
            expect(() =>
                ChangelogService.update("id-1", { version: "1.19.0-foo" }),
            ).to.throw();
        });
    });
});
