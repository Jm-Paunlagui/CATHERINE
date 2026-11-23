import { AlertNotifierService } from "../../../src/services/AlertNotifierService";
import MetricsService from "../../../src/services/MetricsService";
import ServerNotificationService from "../../../src/services/email/ServerNotificationService";
import ServerAlertLogModel from "../../../src/models/serverAlertLog.model";
import { logger } from "../../../src/utils/logger";

const alertOf = (severity: "warning" | "critical" = "critical") => ({ rule: "ORACLE_POOL_DOWN", severity, pool: "app", value: 1, description: "pool down" });
const KEY = "ORACLE_POOL_DOWN::app";

describe("AlertNotifierService poll-tick reliability", () => {
    let svc: any;
    let alerts: any[];
    let holds: string[];
    let send: ReturnType<typeof vi.spyOn>;

    const tick = async () => { await svc._pollTick(); };

    beforeEach(() => {
        svc = new AlertNotifierService();
        svc._acksHydrated = true; // boot-time ack read already done
        alerts = [];
        holds = [];
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
        vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined as never);
        vi.spyOn(MetricsService, "getClusterSnapshot").mockImplementation((() => Promise.resolve({ totals: {}, red: {}, system: {}, dependencies: {} })) as any);
        vi.spyOn(MetricsService, "evaluateAlerts").mockImplementation((() => alerts) as any);
        vi.spyOn(MetricsService, "evaluateAlertHolds").mockImplementation((() => holds) as any);
        send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n" } as never);
        process.env.ALERT_RECOVERY_CONFIRM_POLLS = "2";
    });
    afterEach(() => {
        delete process.env.ALERT_RECOVERY_CONFIRM_POLLS;
        svc.stop();
        vi.restoreAllMocks();
    });

    it("an alert fires one email, is not re-sent inside the cooldown, and recovers after the confirm polls", async () => {
        alerts = [alertOf()];
        await tick();
        expect(send).toHaveBeenCalledTimes(1);
        await tick();
        expect(send).toHaveBeenCalledTimes(1);
        alerts = [];
        await tick(); // 1st clear poll: counting down
        expect(send).toHaveBeenCalledTimes(1);
        await tick(); // 2nd: recovered
        expect(send).toHaveBeenCalledTimes(2);
        expect((send.mock.calls[1][1] as any).severity).toBe("RESOLVED");
        expect(svc._alertStates.get(KEY).status).toBe("OK");
    });

    it("a rule held this tick is neither recovered nor has its countdown advanced (absence is not recovery)", async () => {
        alerts = [alertOf()];
        await tick();
        alerts = [];
        holds = [KEY];
        for (let i = 0; i < 5; i++) await tick();
        expect(send).toHaveBeenCalledTimes(1);
        expect(svc._alertStates.get(KEY).status).toBe("CRITICAL");
        expect(svc._alertStates.get(KEY).clearPollCount).toBe(0);
    });

    it("a cluster-wide hold ('*', a worker missed the gather) holds every active alert", async () => {
        alerts = [alertOf()];
        await tick();
        alerts = [];
        holds = ["*"];
        for (let i = 0; i < 5; i++) await tick();
        expect(svc._alertStates.get(KEY).status).toBe("CRITICAL");
        holds = [];
        await tick();
        await tick();
        expect(svc._alertStates.get(KEY).status).toBe("OK");
    });

    it("after a restart a still-valid acknowledgement suppresses the first FIRED email and starts the cooldown", async () => {
        svc._acks.set(KEY, { ackedBy: 1, ackedAt: Date.now(), expiresAt: Date.now() + 3_600_000, severityAtAck: "CRITICAL", note: null });
        alerts = [alertOf("critical")];
        await tick();
        expect(send).not.toHaveBeenCalled();
        expect(svc._alertStates.get(KEY).lastNotifiedAt).not.toBeNull();
        expect(svc._acks.has(KEY)).toBe(true);
    });

    it("an acknowledgement does not mute a worsening incident (escalation clears it and mails)", async () => {
        svc._acks.set(KEY, { ackedBy: 1, ackedAt: Date.now(), expiresAt: Date.now() + 3_600_000, severityAtAck: "WARNING", note: null });
        vi.spyOn(svc, "_clearAck").mockImplementation(() => { svc._acks.delete(KEY); });
        alerts = [alertOf("critical")];
        await tick();
        expect(send).toHaveBeenCalledTimes(1);
        expect(svc._acks.has(KEY)).toBe(false);
    });

    it("a lapsed acknowledgement does not suppress anything", async () => {
        svc._acks.set(KEY, { ackedBy: 1, ackedAt: Date.now() - 10_000, expiresAt: Date.now() - 1, severityAtAck: "CRITICAL", note: null });
        vi.spyOn(svc, "_clearAck").mockImplementation(() => { svc._acks.delete(KEY); });
        alerts = [alertOf()];
        await tick();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("an escalation WARNING -> CRITICAL mails again; a de-escalation CRITICAL -> WARNING does not", async () => {
        alerts = [alertOf("warning")];
        await tick();
        alerts = [alertOf("critical")];
        await tick();
        expect(send).toHaveBeenCalledTimes(2);
        alerts = [alertOf("warning")];
        await tick();
        expect(send).toHaveBeenCalledTimes(2);
    });

    it("a failed snapshot gather skips the tick and keeps alert state intact", async () => {
        alerts = [alertOf()];
        await tick();
        (MetricsService.getClusterSnapshot as any).mockRejectedValueOnce(new Error("gather broke"));
        await expect(svc._pollTick()).resolves.toBeUndefined();
        expect(svc._alertStates.get(KEY).status).toBe("CRITICAL");
        expect(logger.warning).toHaveBeenCalled();
    });

    it("a failing mail send never throws out of the tick and the pending state is still recorded", async () => {
        send.mockResolvedValue({ sent: false, reason: "error", cause: "SMTP down" } as never);
        alerts = [alertOf()];
        await expect(svc._pollTick()).resolves.toBeUndefined();
        expect(svc._alertStates.get(KEY).status).toBe("CRITICAL");
    });

    it("an unacknowledged boot (acks not yet hydrated) waits a bounded time for the read, never stalling the alert", async () => {
        vi.useFakeTimers();
        try {
            svc._acksHydrated = false;
            vi.spyOn(svc, "_hydrateAcksShared").mockReturnValue(new Promise(() => {}) as never);
            alerts = [alertOf()];
            const p = svc._pollTick();
            await vi.advanceTimersByTimeAsync(60_000);
            await p;
            expect(send).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("with no alerts and acks not hydrated the hydration is only kicked off, not awaited", async () => {
        svc._acksHydrated = false;
        const hydrate = vi.spyOn(svc, "_hydrateAcksShared").mockReturnValue(new Promise(() => {}) as never);
        await svc._pollTick();
        expect(hydrate).toHaveBeenCalledTimes(1);
        expect(send).not.toHaveBeenCalled();
    });
});
