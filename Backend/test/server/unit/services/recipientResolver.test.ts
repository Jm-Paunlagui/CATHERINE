import { RecipientResolver } from "../../../../src/services/email/RecipientResolver";
import { clusterRpc } from "../../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_METHODS } from "../../../../src/constants/clusterIpc";
import { logger } from "../../../../src/utils/logger";
import AdminModel from "../../../../src/models/admin.model";

let r: RecipientResolver;
let savedMin: string | undefined;

beforeEach(() => {
    savedMin = process.env.RECIPIENT_REFRESH_MIN;
    r = new RecipientResolver();
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedMin === undefined) delete process.env.RECIPIENT_REFRESH_MIN; else process.env.RECIPIENT_REFRESH_MIN = savedMin;
});

describe("RecipientResolver configuration", () => {
    it("starts empty and stale", () => {
        expect(r._cache.size).toBe(0);
        expect(r._lastRefreshAt).toBe(0);
        expect(r._lastRefreshOk).toBe(false);
        expect(RecipientResolver.REFRESH_WAIT_MS).toBe(2000);
    });
    it("_refreshMinutes defaults to 5 and honours a numeric override", () => {
        delete process.env.RECIPIENT_REFRESH_MIN;
        expect(r._refreshMinutes()).toBe(5);
        process.env.RECIPIENT_REFRESH_MIN = "12";
        expect(r._refreshMinutes()).toBe(12);
        process.env.RECIPIENT_REFRESH_MIN = "nope";
        expect(r._refreshMinutes()).toBe(5);
    });
});

describe("invalidation", () => {
    it("invalidate marks stale and tells the cluster only when RPC is active", () => {
        r._lastRefreshAt = 123;
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(false);
        r.invalidate();
        expect(r._lastRefreshAt).toBe(0);
        expect(notify).not.toHaveBeenCalled();
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        r._lastRefreshAt = 5;
        r.invalidate();
        expect(notify).toHaveBeenCalledWith(CLUSTER_RPC_METHODS.RECIPIENTS_INVALIDATE, {});
    });
    it("applyRemoteInvalidate marks stale without re-broadcasting", () => {
        const notify = vi.spyOn(clusterRpc, "notify");
        r._lastRefreshAt = 99;
        r.applyRemoteInvalidate();
        expect(r._lastRefreshAt).toBe(0);
        expect(notify).not.toHaveBeenCalled();
    });
});

describe("_maybeRefresh", () => {
    it("skips a fresh cache", async () => {
        const doRefresh = vi.spyOn(r, "_doRefresh").mockResolvedValue();
        r._lastRefreshAt = Date.now();
        await r._maybeRefresh();
        expect(doRefresh).not.toHaveBeenCalled();
    });
    it("coalesces concurrent refreshes into one and clears the in-flight promise", async () => {
        const doRefresh = vi.spyOn(r, "_doRefresh").mockResolvedValue();
        await Promise.all([r._maybeRefresh(), r._maybeRefresh(), r._maybeRefresh()]);
        expect(doRefresh).toHaveBeenCalledTimes(1);
        expect(r._refreshPromise).toBeNull();
    });
    it("refreshes again once the TTL has elapsed", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
        process.env.RECIPIENT_REFRESH_MIN = "1";
        const doRefresh = vi.spyOn(r, "_doRefresh").mockImplementation(async () => { r._lastRefreshAt = Date.now(); });
        await r._maybeRefresh();
        vi.setSystemTime(new Date("2026-01-01T00:10:30Z"));
        await r._maybeRefresh();
        expect(doRefresh).toHaveBeenCalledTimes(1);
        vi.setSystemTime(new Date("2026-01-01T00:11:01Z"));
        await r._maybeRefresh();
        expect(doRefresh).toHaveBeenCalledTimes(2);
    });
});

describe("_doRefresh (database unreachable)", () => {
    it("serves the stale cache, flags the refresh as failed and stamps the attempt", async () => {
        // Fail the read explicitly: Bun auto-loads .env, so with a local Oracle
        // running the real query would succeed and the test would depend on the host.
        vi.spyOn(AdminModel, "findServerNotifyRecipients").mockRejectedValue(new Error("ORA-12541: no listener"));
        r._cache = new Map([["backup", ["stale@x.test"]]]);
        r._lastRefreshOk = true;
        await r._doRefresh();
        expect(r._lastRefreshOk).toBe(false);
        expect(r._cache.get("backup")).toEqual(["stale@x.test"]);
        expect(r._lastRefreshAt).toBeGreaterThan(0);
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("refresh failed, serving stale cache"), { _noNotify: true });
    });
});

describe("_refreshBounded", () => {
    it("returns promptly when the refresh finishes within the wait budget", async () => {
        vi.spyOn(r, "_maybeRefresh").mockResolvedValue();
        expect(await r._refreshBounded()).toEqual({ timedOut: false });
        expect(logger.warning).not.toHaveBeenCalled();
    });
    it("gives up after REFRESH_WAIT_MS and warns with the loop guard flag", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        vi.spyOn(r, "_maybeRefresh").mockReturnValue(new Promise(() => undefined));
        const p = r._refreshBounded();
        await vi.advanceTimersByTimeAsync(RecipientResolver.REFRESH_WAIT_MS);
        expect(await p).toEqual({ timedOut: true });
        expect(logger.warning).toHaveBeenCalledWith(expect.any(String), { _noNotify: true });
    });
});

describe("lookups", () => {
    it("getDbRecipients returns the cached list for a channel, or [] for unknown ones", async () => {
        vi.spyOn(r, "_refreshBounded").mockResolvedValue({ timedOut: false });
        r._cache = new Map([["backup", ["a@x.test"]]]);
        expect(await r.getDbRecipients("backup")).toEqual(["a@x.test"]);
        expect(await r.getDbRecipients("other")).toEqual([]);
    });
    it("getDbRecipientsWithState reports DB down without refreshing when pools are unhealthy", async () => {
        vi.spyOn(r, "_poolsHealthy").mockReturnValue(false);
        const refresh = vi.spyOn(r, "_refreshBounded");
        expect(await r.getDbRecipientsWithState("backup")).toEqual({ dbUp: false, emails: [] });
        expect(refresh).not.toHaveBeenCalled();
    });
    it("reports emails only when the refresh finished and succeeded", async () => {
        vi.spyOn(r, "_poolsHealthy").mockReturnValue(true);
        r._cache = new Map([["backup", ["a@x.test"]]]);
        const refresh = vi.spyOn(r, "_refreshBounded").mockResolvedValue({ timedOut: false });
        r._lastRefreshOk = true;
        expect(await r.getDbRecipientsWithState("backup")).toEqual({ dbUp: true, emails: ["a@x.test"] });
        expect(await r.getDbRecipientsWithState("nochannel")).toEqual({ dbUp: true, emails: [] });
        r._lastRefreshOk = false;
        expect(await r.getDbRecipientsWithState("backup")).toEqual({ dbUp: false, emails: [] });
        r._lastRefreshOk = true;
        refresh.mockResolvedValue({ timedOut: true });
        expect(await r.getDbRecipientsWithState("backup")).toEqual({ dbUp: false, emails: [] });
    });
    it("_poolsHealthy returns a boolean and never throws", () => {
        expect(typeof r._poolsHealthy()).toBe("boolean");
    });
});
