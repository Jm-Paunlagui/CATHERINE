import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAlertSignature } from "../../../../src/utils/alerts/alertSignature";
import ServerAlertLogModel from "../../../../src/models/serverAlertLog.model";
import AlertSignatureStore from "../../../../src/services/AlertSignatureStore";
import SchedulerStateService from "../../../../src/services/SchedulerStateService";
import { clusterRpc } from "../../../../src/utils/cluster/ClusterRpcClient";
import { logger } from "../../../../src/utils/logger";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("computeAlertSignature", () => {
    it("falls back to a fixed dev key when DATA_SIGNING_SECRET is unset (deterministic, still keyed)", async () => {
        vi.resetModules();
        const prev = process.env.DATA_SIGNING_SECRET;
        delete process.env.DATA_SIGNING_SECRET;
        try {
            const a = await import("../../../../src/utils/alerts/alertSignature");
            const first = a.computeAlertSignature("K", [1]);
            expect(first).toMatch(/^[0-9a-f]{64}$/);
            expect(a.computeAlertSignature("K", [1])).toBe(first);
        } finally {
            if (prev !== undefined) process.env.DATA_SIGNING_SECRET = prev;
        }
    });

    it("is a 64-char lowercase hex digest", () => {
        expect(computeAlertSignature("K", [1, 2])).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is order independent for numeric members and sorts numerically (2 < 10)", () => {
        expect(computeAlertSignature("K", [10, 2, 33])).toBe(computeAlertSignature("K", [33, 10, 2]));
        // numeric-string members behave like numbers
        expect(computeAlertSignature("K", ["10", "2"])).toBe(computeAlertSignature("K", ["2", "10"]));
    });

    it("sorts string members lexically, both comparison directions, and stays order independent", () => {
        const a = computeAlertSignature("K", ["b", "a", "c", "a"]);
        expect(a).toBe(computeAlertSignature("K", ["c", "a", "b", "a"]));
        expect(a).not.toBe(computeAlertSignature("K", ["a", "b", "c"]));
    });

    it("treats an empty-string member as non numeric (string sort)", () => {
        expect(computeAlertSignature("K", ["", "b"])).toBe(computeAlertSignature("K", ["b", ""]));
    });

    it("does not mutate the input array", () => {
        const input = [3, 1, 2];
        computeAlertSignature("K", input);
        expect(input).toEqual([3, 1, 2]);
    });

    it("includes kind so a kind switch over the same set changes the signature", () => {
        expect(computeAlertSignature("A", [1])).not.toBe(computeAlertSignature("B", [1]));
    });

    it("tolerates null members as the empty set", () => {
        expect(computeAlertSignature("K", null as never)).toBe(computeAlertSignature("K", []));
    });

    it("is keyed: a different DATA_SIGNING_SECRET yields a different value (security)", async () => {
        const before = computeAlertSignature("K", [1]);
        vi.resetModules();
        const prev = process.env.DATA_SIGNING_SECRET;
        process.env.DATA_SIGNING_SECRET = "another-secret-value";
        try {
            const mod = await import("../../../../src/utils/alerts/alertSignature");
            expect(mod.computeAlertSignature("K", [1])).not.toBe(before);
        } finally {
            if (prev === undefined) delete process.env.DATA_SIGNING_SECRET;
            else process.env.DATA_SIGNING_SECRET = prev;
        }
    });
});

function makeStore(model: any) {
    const logger = { warning: vi.fn() };
    const messages: any = {
        readFailed: vi.fn((k: string, e: string, l: string) => `read ${k} ${e} ${l}`),
        writeFailed: vi.fn((k: string, e: string, l: string) => `write ${k} ${e} ${l}`),
    };
    return { store: new AlertSignatureStore({ rule: "RULE", model, logger, messages }), logger, messages };
}

describe("AlertSignatureStore", () => {
    it("defaults to the shared alert-log model when none is injected", () => {
        const store = new AlertSignatureStore({ rule: "R", logger: { warning: vi.fn() }, messages: { readFailed: vi.fn(), writeFailed: vi.fn() } });
        expect(store._model).toBe(ServerAlertLogModel);
    });

    it("builds rule::scope keys", () => {
        const { store } = makeStore({});
        expect(store.alertKey("p1")).toBe("RULE::p1");
    });

    it("getLastSignature returns the hash of a FIRED row", async () => {
        const model = { findLatestByAlertKey: vi.fn().mockResolvedValue({ TRANSITION: "FIRED", DETAILS: { signatureHash: "abc" } }), insertOne: vi.fn() };
        const { store } = makeStore(model);
        await expect(store.getLastSignature("p1")).resolves.toBe("abc");
        expect(model.findLatestByAlertKey).toHaveBeenCalledWith("RULE", "RULE::p1");
    });

    it.each([
        ["no row", null],
        ["recovered row", { TRANSITION: "RECOVERED", DETAILS: { signatureHash: "abc" } }],
        ["fired without details", { TRANSITION: "FIRED" }],
        ["fired with non-string hash", { TRANSITION: "FIRED", DETAILS: { signatureHash: 5 } }],
        ["fired with empty hash", { TRANSITION: "FIRED", DETAILS: { signatureHash: "" } }],
    ])("getLastSignature returns null for %s", async (_n, row) => {
        const { store } = makeStore({ findLatestByAlertKey: vi.fn().mockResolvedValue(row), insertOne: vi.fn() });
        await expect(store.getLastSignature("p")).resolves.toBeNull();
    });

    it("getLastSignature returns undefined and warns on read failure (fail open)", async () => {
        const { store, logger, messages } = makeStore({ findLatestByAlertKey: vi.fn().mockRejectedValue(new Error("boom")), insertOne: vi.fn() });
        await expect(store.getLastSignature("p", { label: "L" })).resolves.toBeUndefined();
        expect(messages.readFailed).toHaveBeenCalledWith("p", "boom", "L");
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("recordFired writes a SKIPPED CRITICAL state row carrying only the hash", async () => {
        const model = { findLatestByAlertKey: vi.fn(), insertOne: vi.fn().mockResolvedValue(undefined) };
        const { store } = makeStore(model);
        await expect(store.recordFired("p", { signatureHash: "h", kind: "K", count: 3, label: "L", description: "d" })).resolves.toBe(true);
        expect(model.insertOne).toHaveBeenCalledWith(expect.objectContaining({
            alertKey: "RULE::p", rule: "RULE", channel: "server-critical-notification", notificationId: null,
            emailStatus: "SKIPPED", emailError: null, severity: "CRITICAL", transition: "FIRED", valueNum: 3,
            details: { signatureHash: "h", kind: "K", count: 3, label: "L", stateRow: true },
        }));
    });

    it("recordResolved writes a RECOVERED row with null signature", async () => {
        const model = { findLatestByAlertKey: vi.fn(), insertOne: vi.fn().mockResolvedValue(undefined) };
        const { store } = makeStore(model);
        await expect(store.recordResolved("p", { label: "L", description: "d" })).resolves.toBe(true);
        expect(model.insertOne).toHaveBeenCalledWith(expect.objectContaining({
            severity: "RESOLVED", transition: "RECOVERED", valueNum: 0,
            details: { signatureHash: null, kind: null, count: 0, label: "L", stateRow: true },
        }));
    });

    it("write failure returns false and warns (non Error cause stringified)", async () => {
        const { store, messages } = makeStore({ findLatestByAlertKey: vi.fn(), insertOne: vi.fn().mockRejectedValue("plain") });
        await expect(store.recordResolved("p", { label: "L", description: "d" })).resolves.toBe(false);
        expect(messages.writeFailed).toHaveBeenCalledWith("p", "plain", "L");
    });

    it("a throwing logger/template never breaks the caller", async () => {
        const model = { findLatestByAlertKey: vi.fn().mockRejectedValue(new Error("x")), insertOne: vi.fn() };
        const store = new AlertSignatureStore({
            rule: "R", model,
            logger: { warning: () => { throw new Error("log down"); } },
            messages: { readFailed: () => "m", writeFailed: () => "m" },
        });
        await expect(store.getLastSignature("p")).resolves.toBeUndefined();
    });
});

describe("SchedulerStateService", () => {
    it("record ignores unknown jobs with a warning", () => {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        SchedulerStateService.record("nope", { status: "success" });
        expect(warn).toHaveBeenCalled();
        expect(SchedulerStateService.snapshot()).not.toHaveProperty("nope");
    });

    it("record stores local state and does not notify when cluster rpc is inactive", () => {
        vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        const notify = vi.spyOn(clusterRpc, "notify");
        const at = new Date("2026-01-01T00:00:00Z");
        SchedulerStateService.record("dbBackup", { label: "cron", status: "success", detail: "ok", at });
        expect(SchedulerStateService.snapshot().dbBackup).toEqual({ job: "dbBackup", label: "cron", status: "success", detail: "ok", at });
        expect(notify).not.toHaveBeenCalled();
    });

    it("record notifies the primary with truncated fields when cluster rpc is active", () => {
        vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
        const at = new Date("2026-02-02T00:00:00Z");
        SchedulerStateService.record("dbBackup", { label: "x".repeat(100), status: "error", detail: "d".repeat(3000), at });
        const payload = notify.mock.calls[0][1] as any;
        expect(notify.mock.calls[0][0]).toBe("sched.record");
        expect(payload.job).toBe("dbBackup");
        expect(payload.outcome.label).toHaveLength(64);
        expect(payload.outcome.detail).toHaveLength(2000);
        expect(payload.outcome.at).toBe(at.toISOString());
    });

    it("record notifies with null detail, empty label/status and a fallback timestamp for an invalid date", () => {
        vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
        SchedulerStateService.record("dbBackup", { detail: null, at: "garbage" as never });
        const o = (notify.mock.calls[0][1] as any).outcome;
        expect(o.label).toBe("");
        expect(o.status).toBe("");
        expect(o.detail).toBeNull();
        expect(Number.isNaN(Date.parse(o.at))).toBe(false);
    });

    it("record with a string date converts it for the notify payload", () => {
        vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
        SchedulerStateService.record("dbBackup", { status: "s", at: "2026-03-03T00:00:00.000Z" as never });
        expect((notify.mock.calls[0][1] as any).outcome.at).toBe("2026-03-03T00:00:00.000Z");
    });

    it("record defaults to an empty outcome object", () => {
        vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        SchedulerStateService.record("dbBackup");
        expect(SchedulerStateService.snapshot().dbBackup?.detail).toBeNull();
    });

    it("applyRemote rejects unknown jobs and empty outcomes, applies valid ones", () => {
        expect(SchedulerStateService.applyRemote("nope", { label: "l", status: "s", detail: null, at: new Date() })).toBe(false);
        expect(SchedulerStateService.applyRemote("dbBackup", undefined as never)).toBe(false);
        expect(SchedulerStateService.applyRemote("dbBackup", { label: "l", status: "s", detail: undefined as never, at: "2026-04-04T00:00:00.000Z" })).toBe(true);
        const s = SchedulerStateService.snapshot().dbBackup!;
        expect(s.detail).toBeNull();
        expect(s.at).toEqual(new Date("2026-04-04T00:00:00.000Z"));
    });

    it("applySync keeps a newer local entry, applies older-local and skips invalid entries", () => {
        SchedulerStateService.applyRemote("dbBackup", { label: "local", status: "s", detail: null, at: "2030-01-01T00:00:00.000Z" });
        const outcome = { label: "remote", status: "s", detail: null, at: "2020-01-01T00:00:00.000Z" };
        expect(SchedulerStateService.applySync([{ job: "dbBackup", outcome }])).toBe(0);
        expect(SchedulerStateService.snapshot().dbBackup?.label).toBe("local");
        expect(SchedulerStateService.applySync([{ job: "dbBackup", outcome: { ...outcome, at: "2031-01-01T00:00:00.000Z" } }, { job: "ghost", outcome }])).toBe(1);
        expect(SchedulerStateService.snapshot().dbBackup?.label).toBe("remote");
        expect(SchedulerStateService.applySync(undefined as never)).toBe(0);
    });
});
