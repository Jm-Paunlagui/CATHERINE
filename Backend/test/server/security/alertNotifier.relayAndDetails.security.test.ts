import { AlertNotifierService } from "../../../src/services/AlertNotifierService";
import { clusterRpc, ClusterRpcError } from "../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_ERROR_CODES as E } from "../../../src/constants/clusterIpc";
import AdminModel from "../../../src/models/admin.model";
import ServerNotificationService from "../../../src/services/email/ServerNotificationService";
import { logger } from "../../../src/utils/logger";

describe("AlertNotifierService untrusted input", () => {
    let svc: any;
    let tapped: any[];
    beforeEach(() => {
        svc = new AlertNotifierService();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
        tapped = [];
        vi.spyOn(svc, "_onCriticalLog").mockImplementation((r: any) => { tapped.push(r); });
    });
    afterEach(() => { svc.stop(); vi.restoreAllMocks(); });

    describe("ingestRelayedCritical (IPC input is never trusted)", () => {
        beforeEach(() => { svc._running = true; });

        it("is a no-op unless the notifier is running, and for non-object records", () => {
            svc._running = false;
            expect(svc.ingestRelayedCritical({ message: "x" })).toBe(false);
            svc._running = true;
            expect(svc.ingestRelayedCritical(null as any)).toBe(false);
            expect(svc.ingestRelayedCritical("str" as any)).toBe(false);
            expect(tapped).toHaveLength(0);
        });

        it("coerces an unknown or missing level to CRITICAL (no spoofed severities)", () => {
            svc.ingestRelayedCritical({ level: "DEBUG", message: "m" });
            svc.ingestRelayedCritical({ message: "m" });
            svc.ingestRelayedCritical({ level: "EMERGENCY", message: "m" });
            expect(tapped.map((r) => r.level)).toEqual(["CRITICAL", "CRITICAL", "EMERGENCY"]);
        });

        it("truncates a huge message and copies meta rather than sharing the sender's object", () => {
            const meta: any = { a: 1 };
            svc.ingestRelayedCritical({ message: "x".repeat(100_000), meta });
            expect(tapped[0].message.length).toBeLessThanOrEqual(4000);
            expect(tapped[0].meta).toEqual({ a: 1 });
            expect(tapped[0].meta).not.toBe(meta);
        });

        it("non-object meta becomes {}; a finite pid is stamped, a non-finite one is not", () => {
            svc.ingestRelayedCritical({ message: "m", meta: "evil" as any, pid: 4321 });
            svc.ingestRelayedCritical({ message: "m", meta: 5 as any, pid: Number.NaN });
            expect(tapped[0].meta).toEqual({ relayedFromPid: 4321 });
            expect(tapped[1].meta).toEqual({});
        });

        it("request id must be a string; a bad timestamp falls back to now", () => {
            const before = Date.now();
            svc.ingestRelayedCritical({ message: "m", requestId: 7 as any, timestamp: "garbage" });
            svc.ingestRelayedCritical({ message: "m", requestId: "req-1", timestamp: "2026-01-01T00:00:00.000Z" });
            expect(tapped[0].requestId).toBeNull();
            expect(Date.parse(tapped[0].timestamp)).toBeGreaterThanOrEqual(before - 1);
            expect(tapped[1]).toMatchObject({ requestId: "req-1", timestamp: "2026-01-01T00:00:00.000Z" });
        });
    });

    describe("_sanitizeDetails (CWE-532)", () => {
        it("redacts secrets at any depth, caps stacks, and replaces an oversized payload with a preview", () => {
            const out = svc._sanitizeDetails({ authorization: "Bearer abc", nested: { Cookie: "s=1", ok: 1, list: [{ refreshToken: "t" }] }, stack: "S".repeat(5000) });
            expect(out.authorization).toBe("[REDACTED]");
            expect(out.nested.Cookie).toBe("[REDACTED]");
            expect(out.nested.list[0].refreshToken).toBe("[REDACTED]");
            expect(out.nested.ok).toBe(1);
            expect(out.stack.length).toBeLessThan(2100);
            const huge = svc._sanitizeDetails({ blob: "x".repeat(200_000) });
            expect(huge.truncated).toBe(true);
            expect(JSON.stringify(huge).length).toBeLessThan(70_000);
        });

        it("a short stack and a non-string stack field pass through", () => {
            expect(svc._sanitizeDetails({ stack: "short" }).stack).toBe("short");
            expect(svc._sanitizeDetails({ stack: { frames: 1 } }).stack).toEqual({ frames: 1 });
        });
    });

    describe("leader forwarding (cluster)", () => {
        it("only a non-leader cluster worker forwards to the leader", () => {
            const active = vi.spyOn(clusterRpc, "active", "get");
            const leader = vi.spyOn(clusterRpc, "isLeader", "get");
            active.mockReturnValue(false);
            leader.mockReturnValue(false);
            expect(AlertNotifierService._forwardsToLeader()).toBe(false);
            active.mockReturnValue(true);
            expect(AlertNotifierService._forwardsToLeader()).toBe(true);
            leader.mockReturnValue(true);
            expect(AlertNotifierService._forwardsToLeader()).toBe(false);
        });

        it("an unreachable leader surfaces as a generic 503 and never leaks the IPC error text", async () => {
            vi.spyOn(clusterRpc, "call").mockRejectedValue(new ClusterRpcError(E.TIMEOUT, "alerts.status timed out at /internal/path"));
            const err: any = await svc._forwardToLeader("alerts.status", {}).then(() => null, (e: unknown) => e);
            expect(err.statusCode).toBe(503);
            expect(err.message).not.toContain("/internal/path");
        });

        it("the leader's own operational error keeps its status and message", async () => {
            vi.spyOn(clusterRpc, "call").mockRejectedValue(new ClusterRpcError(E.HANDLER_ERROR, "x", { statusCode: 404, message: "Alert not found", type: "NotFound" }));
            const err: any = await svc._forwardToLeader("alerts.ack", { alertKey: "k" }).then(() => null, (e: unknown) => e);
            expect(err.statusCode).toBe(404);
            expect(err.message).toBe("Alert not found");
        });

        it("the leader's ack list is accepted entry by entry: malformed entries are dropped", async () => {
            vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
            vi.spyOn(clusterRpc, "isLeader", "get").mockReturnValue(false);
            const ok = { ackedBy: 1, ackedAt: 1000, expiresAt: 2000, severityAtAck: "WARNING", note: null };
            vi.spyOn(clusterRpc, "call").mockResolvedValue([
                { alertKey: "A::global", ...ok },
                { alertKey: "B::global", ...ok, severityAtAck: "CRITICAL", note: "n" },
                { alertKey: "C::global", ackedBy: 1, ackedAt: 1000, expiresAt: 2000, severityAtAck: "CRITICAL" },
                null,
                "x",
                { ...ok, alertKey: 5 },
                { alertKey: "D::global", ...ok, severityAtAck: "INFO" },
                { alertKey: "E::global", ...ok, ackedBy: "1" },
                { alertKey: "F::global", ...ok, note: 5 },
            ] as never);
            vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map([[1, "Alice"]]) as never);
            const alerts = ["A", "B", "C", "D", "E", "F"].map((rule) => ({ rule }));
            const out: any[] = await svc.decorateAlertsWithAckState(alerts);
            expect(out.map((a) => a.acknowledged)).toEqual([true, true, true, false, false, false]);
            expect(out[0]).toMatchObject({ ackedByName: "Alice", ackNote: null, ackedAt: new Date(1000).toISOString() });
            expect(out[1].ackNote).toBe("n");
        });

        it("a leader reply that is not a list yields no acks", async () => {
            vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
            vi.spyOn(clusterRpc, "isLeader", "get").mockReturnValue(false);
            vi.spyOn(clusterRpc, "call").mockResolvedValue({ not: "a list" } as never);
            const out: any[] = await svc.decorateAlertsWithAckState([{ rule: "A", pool: "p" }]);
            expect(out[0]).toMatchObject({ acknowledged: false, alertKey: "A::p" });
        });

        it("no alerts short-circuits without any IPC", async () => {
            const call = vi.spyOn(clusterRpc, "call");
            expect(await svc.decorateAlertsWithAckState([])).toEqual([]);
            expect(await svc.decorateAlertsWithAckState(null as any)).toEqual([]);
            expect(call).not.toHaveBeenCalled();
        });
    });

    it("disabled notifications make start() a no-op that reports why", () => {
        vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
        const out = svc.start();
        expect(out.started).toBe(false);
        expect(svc._running).toBe(false);
    });
});
