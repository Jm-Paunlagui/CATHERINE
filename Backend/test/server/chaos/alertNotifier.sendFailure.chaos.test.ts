import { AlertNotifierService } from "../../../src/services/AlertNotifierService";
import ServerNotificationService from "../../../src/services/email/ServerNotificationService";
import ServerAlertLogModel from "../../../src/models/serverAlertLog.model";
import { logger } from "../../../src/utils/logger";

describe("AlertNotifierService send chaos", () => {
    let svc: any;
    beforeEach(() => {
        vi.useFakeTimers();
        svc = new AlertNotifierService();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
        vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined as never);
        vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
    });
    afterEach(() => {
        svc.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("notifyCriticalNow: a hung SMTP server is cut off at the 5s bound with a timeout result", async () => {
        vi.spyOn(svc, "_dispatchCriticalDigest").mockReturnValue(new Promise(() => {}) as never);
        const p = svc.notifyCriticalNow({ message: "process crashing" });
        await vi.advanceTimersByTimeAsync(4999);
        let settled = false;
        p.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(p).resolves.toEqual({ sent: false, reason: "timeout" });
    });

    it("notifyCriticalNow: a fast send wins the race and carries the level and message to the digest", async () => {
        const dispatch = vi.spyOn(svc, "_dispatchCriticalDigest").mockResolvedValue({ sent: true, notificationId: "n" } as never);
        await expect(svc.notifyCriticalNow({ level: "ALERT", message: "boom", meta: { a: 1 } })).resolves.toEqual({ sent: true, notificationId: "n" });
        expect((dispatch.mock.calls as any[][])[0][0][0]).toMatchObject({ level: "ALERT", message: "boom", meta: { a: 1 }, requestId: null });
    });

    it("notifyCriticalNow: defaults to EMERGENCY, tolerates a missing message, and reports 'disabled' when mail is off", async () => {
        const dispatch = vi.spyOn(svc, "_dispatchCriticalDigest").mockResolvedValue({ sent: true } as never);
        await svc.notifyCriticalNow({ message: undefined as any });
        expect((dispatch.mock.calls as any[][])[0][0][0]).toMatchObject({ level: "EMERGENCY", message: "" });
        (ServerNotificationService.isEnabled as any).mockReturnValue(false);
        await expect(svc.notifyCriticalNow({ message: "x" })).resolves.toEqual({ sent: false, reason: "disabled" });
    });

    it("notifyLifecycleNow: a hung send times out at 5s but the persisted row still waits for the real outcome", async () => {
        let finish!: (v: unknown) => void;
        vi.spyOn(ServerNotificationService, "sendChannelDigest").mockReturnValue(new Promise((r) => { finish = r; }) as never);
        const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
        const p = svc.notifyLifecycleNow({ severity: "CRITICAL", headline: "h", summary: "s", rows: [{ rule: "R", description: "d", severity: "CRITICAL" }], persist: true });
        await vi.advanceTimersByTimeAsync(5000);
        await expect(p).resolves.toEqual({ sent: false, reason: "timeout" });
        expect(write).not.toHaveBeenCalled();
        finish({ sent: true, notificationId: "late" });
        await vi.advanceTimersByTimeAsync(0);
        expect((write.mock.calls as any[][])[0][0][0]).toMatchObject({ emailStatus: "SENT", notificationId: "late" });
    });

    it("alert-log writes during a DB outage stay queued in order and drain once the pool recovers", async () => {
        const insert = vi.spyOn(ServerAlertLogModel, "insertOne");
        insert.mockRejectedValue(new Error("ORA-12541"));
        const row = (n: number) => ({ alertKey: `k${n}`, rule: "R", severity: "WARNING", transition: "FIRED" } as any);
        svc._alertLogQueue.push(row(1), row(2), row(3));
        await svc._flushAlertLogQueue();
        expect(svc._alertLogQueue).toHaveLength(3); // stopped at the first failure, nothing lost
        insert.mockResolvedValue(undefined as never);
        await svc._flushAlertLogQueue();
        expect(svc._alertLogQueue).toHaveLength(0);
        expect(insert.mock.calls.slice(-3).map((c) => (c[0] as any).alertKey)).toEqual(["k1", "k2", "k3"]);
    });

    it("overlapping flushes share one in-flight run (no row is inserted twice)", async () => {
        const insert = vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined as never);
        svc._alertLogQueue.push({ alertKey: "only", rule: "R", severity: "WARNING", transition: "FIRED" } as any);
        const a = svc._flushAlertLogQueue();
        const b = svc._flushAlertLogQueue();
        await Promise.all([a, b]);
        expect(insert).toHaveBeenCalledTimes(1);
    });

    it("a non-Error alert-log failure is logged and the row is kept", async () => {
        vi.spyOn(ServerAlertLogModel, "insertOne").mockRejectedValue("string failure");
        svc._alertLogQueue.push({ alertKey: "k", rule: "R", severity: "WARNING", transition: "FIRED" } as any);
        await svc._flushAlertLogQueue();
        expect(svc._alertLogQueue).toHaveLength(1);
        expect(logger.warning).toHaveBeenCalled();
    });
});
