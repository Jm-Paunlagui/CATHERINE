/**
 * @fileoverview MetricsController: alert history validation, notification test
 * send actor resolution, ack/unack.
 */
import MetricsController from "../../../../src/controllers/MetricsController";
import AlertNotifierService from "../../../../src/services/AlertNotifierService";

type Outcome = { json?: any; error?: any };
function run(handler: (req: any, res: any, next: any) => void, req: Record<string, unknown>): Promise<Outcome> {
    return new Promise((resolve) => {
        const out: Outcome = {};
        const res: any = { json(b: unknown) { out.json = b; resolve(out); return res; } };
        handler(req, res, (err: unknown) => { out.error = err; resolve(out); });
    });
}

describe("MetricsController wave2b", () => {
    afterEach(() => vi.restoreAllMocks());

    describe("getAlertHistory", () => {
        it("rejects an unknown severity with 400", async () => {
            const out = await run(MetricsController.getAlertHistory, { query: { severity: "bogus" } });
            expect(out.error).toMatchObject({ statusCode: 400 });
            expect(out.error.details[0].field).toBe("severity");
        });
        it.each([["from"], ["to"]])("rejects an unparseable %s date with 400", async (field) => {
            const out = await run(MetricsController.getAlertHistory, { query: { [field]: "not-a-date" } });
            expect(out.error).toMatchObject({ statusCode: 400 });
            expect(out.error.details[0].field).toBe(field);
        });
        it("rejects from after to", async () => {
            const out = await run(MetricsController.getAlertHistory, { query: { from: "2026-02-01", to: "2026-01-01" } });
            expect(out.error).toMatchObject({ statusCode: 400 });
            expect(out.error.details[0].issue).toMatch(/on or before/);
        });
        it("normalises filters (severity upper-cased, dates parsed, empty rule dropped)", async () => {
            const spy = vi.spyOn(AlertNotifierService, "getAlertHistory").mockResolvedValue({ rows: [] } as never);
            const out = await run(MetricsController.getAlertHistory, { query: { severity: "critical", rule: "", from: "2026-01-01", to: "2026-01-02", page: "2", limit: "5" } });
            expect(spy).toHaveBeenCalledWith(
                { rule: undefined, severity: "CRITICAL", from: new Date("2026-01-01"), to: new Date("2026-01-02") },
                { page: "2", limit: "5" },
            );
            expect(out.json.data).toEqual({ rows: [] });
        });
        it("passes a rule through and treats empty strings as absent filters", async () => {
            const spy = vi.spyOn(AlertNotifierService, "getAlertHistory").mockResolvedValue({} as never);
            await run(MetricsController.getAlertHistory, { query: { rule: "cpu", severity: "", from: "", to: "" } });
            expect(spy).toHaveBeenCalledWith({ rule: "cpu", severity: undefined, from: undefined, to: undefined }, { page: undefined, limit: undefined });
        });
        it("a non-string rule (array) is ignored", async () => {
            const spy = vi.spyOn(AlertNotifierService, "getAlertHistory").mockResolvedValue({} as never);
            await run(MetricsController.getAlertHistory, { query: { rule: ["a", "b"] } });
            expect(spy.mock.calls[0]![0]!.rule).toBeUndefined();
        });
    });

    describe("testSendNotification", () => {
        it("uses the numeric id as the actor and tolerates a missing body", async () => {
            const spy = vi.spyOn(AlertNotifierService, "sendTestNotification").mockResolvedValue({ sent: true } as never);
            const user = { id: 3, username: "bob" };
            const out = await run(MetricsController.testSendNotification, { user, body: { channel: "email" } });
            expect(spy).toHaveBeenCalledWith("email", user);
            expect(out.json.data).toEqual({ sent: true });
            await run(MetricsController.testSendNotification, { user });
            expect(spy).toHaveBeenLastCalledWith(undefined, user);
        });
        it("falls back to the userId claim", async () => {
            vi.spyOn(AlertNotifierService, "sendTestNotification").mockResolvedValue({} as never);
            const out = await run(MetricsController.testSendNotification, { user: { userId: "SA1" }, body: { channel: "email" } });
            expect(out.error).toBeUndefined();
        });
        it("is refused (401) without an authenticated user", async () => {
            const out = await run(MetricsController.testSendNotification, { body: {} });
            expect(out.error).toMatchObject({ statusCode: 401 });
        });
    });

    describe("acknowledge / unacknowledge", () => {
        it("acknowledgeAlert forwards key, actor and note; tolerates a missing body", async () => {
            const spy = vi.spyOn(AlertNotifierService, "acknowledge").mockResolvedValue({ acked: true } as never);
            await run(MetricsController.acknowledgeAlert, { user: { id: 4 }, body: { alertKey: "k", note: "n" } });
            expect(spy).toHaveBeenCalledWith("k", 4, "n");
            await run(MetricsController.acknowledgeAlert, { user: { id: 4 } });
            expect(spy).toHaveBeenLastCalledWith(undefined, 4, undefined);
        });
        it("unacknowledgeAlert forwards the key; tolerates a missing body", async () => {
            const spy = vi.spyOn(AlertNotifierService, "unacknowledge").mockResolvedValue({ cleared: true } as never);
            const out = await run(MetricsController.unacknowledgeAlert, { body: { alertKey: "k" } });
            expect(spy).toHaveBeenCalledWith("k");
            expect(out.json.data).toEqual({ cleared: true });
            await run(MetricsController.unacknowledgeAlert, {});
            expect(spy).toHaveBeenLastCalledWith(undefined);
        });
    });
});
