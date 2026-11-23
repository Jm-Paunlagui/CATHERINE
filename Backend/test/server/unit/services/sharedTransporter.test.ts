import fs from "fs";
import path from "path";

import { SharedTransporter } from "../../../../src/services/email/SharedTransporter";
import { logger } from "../../../../src/utils/logger";
import { ProgressScope } from "../../../../src/utils/progress/ProgressScope";
import { runInScope } from "../../../../src/utils/progress/progress";

const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_CA_FILE", "SMTP_FROM", "EMAIL_POOL", "EMAIL_CONCURRENCY", "EMAIL_MAX_MESSAGES", "EMAIL_RATE_DELTA_MS", "EMAIL_RATE_LIMIT"];
const saved: Record<string, string | undefined> = {};
let t: SharedTransporter;

beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    t = new SharedTransporter();
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("_baseConfig", () => {
    it("uses safe defaults", () => {
        expect(t._baseConfig()).toMatchObject({ host: "localhost", port: 587, secure: false, auth: undefined, tls: undefined, connectionTimeout: 10_000, greetingTimeout: 5_000, socketTimeout: 30_000 });
    });
    it("reads host, port, TLS flag and credentials from the environment", () => {
        process.env.SMTP_HOST = "mail.test"; process.env.SMTP_PORT = "2525"; process.env.SMTP_SECURE = "true";
        process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
        expect(t._baseConfig()).toMatchObject({ host: "mail.test", port: 2525, secure: true, auth: { user: "u", pass: "p" } });
    });
    it("falls back to port 587 for a non-numeric port", () => {
        process.env.SMTP_PORT = "abc";
        expect(t._baseConfig().port).toBe(587);
    });
});

describe("_poolConfig", () => {
    it("pools by default with documented defaults", () => {
        expect(t._poolConfig()).toEqual({ pool: true, maxConnections: 4, maxMessages: 100, rateDelta: 60_000, rateLimit: 150 });
    });
    it("can be disabled (case-insensitive)", () => {
        process.env.EMAIL_POOL = "FALSE";
        expect(t._poolConfig()).toEqual({});
    });
    it("accepts positive integers and rejects zero, negatives, junk", () => {
        process.env.EMAIL_CONCURRENCY = "2"; process.env.EMAIL_MAX_MESSAGES = "0";
        process.env.EMAIL_RATE_DELTA_MS = "-5"; process.env.EMAIL_RATE_LIMIT = "x";
        expect(t._poolConfig()).toEqual({ pool: true, maxConnections: 2, maxMessages: 100, rateDelta: 60_000, rateLimit: 150 });
    });
});

describe("transporter lifecycle", () => {
    it("builds one lazy transporter and reuses it, then closeTransporter drops it", () => {
        const a = t.getTransporter();
        expect(t.getTransporter()).toBe(a);
        const close = vi.spyOn(a, "close");
        t.closeTransporter();
        expect(close).toHaveBeenCalledTimes(1);
        expect(t._transporter).toBeNull();
        expect(t.getTransporter()).not.toBe(a);
        t.closeTransporter();
    });
    it("closeTransporter is a no-op when nothing was created", () => {
        expect(() => t.closeTransporter()).not.toThrow();
    });
    it("closeTransporter survives a throwing close() and still clears state", () => {
        t._transporter = { close: () => { throw new Error("socket stuck"); } } as never;
        t.closeTransporter();
        expect(t._transporter).toBeNull();
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("socket stuck"));
    });
    it("closeTransporter tolerates a transporter without close()", () => {
        t._transporter = {} as never;
        t.closeTransporter();
        expect(t._transporter).toBeNull();
    });
    it("createTransport merges overrides over the base config", () => {
        const tr = t.createTransport({ jsonTransport: true } as never);
        expect(typeof tr.sendMail).toBe("function");
    });
    it("getDefaultFrom prefers SMTP_FROM", () => {
        expect(t.getDefaultFrom()).toBe("noreply@app.internal");
        process.env.SMTP_FROM = "ops@x.test";
        expect(t.getDefaultFrom()).toBe("ops@x.test");
    });
});

describe("_instrumentSendMail (SMTP progress heartbeat)", () => {
    it("returns non-transporters and already-instrumented transporters unchanged", () => {
        const noSend = {};
        expect(t._instrumentSendMail(noSend as never)).toBe(noSend);
        expect(t._instrumentSendMail(undefined as never)).toBeUndefined();
        const tr: any = { sendMail: vi.fn().mockResolvedValue("ok") };
        const once = t._instrumentSendMail(tr);
        const wrapped = once.sendMail;
        expect(t._instrumentSendMail(once).sendMail).toBe(wrapped);
    });
    it("touches progress before and after a promise-style send", async () => {
        const scope = new ProgressScope({ label: "smtp", idleLimitMs: 1e9 });
        const touch = vi.spyOn(scope, "touch");
        const tr: any = t._instrumentSendMail({ sendMail: vi.fn().mockResolvedValue("sent") });
        expect(await runInScope(scope, () => tr.sendMail({ to: "x" }))).toBe("sent");
        expect(touch).toHaveBeenCalledTimes(2);
        expect(touch).toHaveBeenCalledWith("smtp");
    });
    it("touches after a failed send too, and rethrows", async () => {
        const scope = new ProgressScope({ label: "smtp", idleLimitMs: 1e9 });
        const touch = vi.spyOn(scope, "touch");
        const tr: any = t._instrumentSendMail({ sendMail: vi.fn().mockRejectedValue(new Error("535")) });
        await expect(runInScope(scope, () => tr.sendMail({}))).rejects.toThrow("535");
        expect(touch).toHaveBeenCalledTimes(2);
    });
    it("passes callback-style calls straight through with a single touch", () => {
        const scope = new ProgressScope({ label: "smtp", idleLimitMs: 1e9 });
        const touch = vi.spyOn(scope, "touch");
        const original = vi.fn().mockReturnValue("cb-result");
        const tr: any = t._instrumentSendMail({ sendMail: original });
        const cb = vi.fn();
        expect(runInScope(scope, () => tr.sendMail({ to: "x" }, cb))).toBe("cb-result");
        expect(original).toHaveBeenCalledWith({ to: "x" }, cb);
        expect(touch).toHaveBeenCalledTimes(1);
    });
});

describe("_buildTlsOptions", () => {
    it("is undefined when no CA file is configured", () => {
        expect(t._buildTlsOptions()).toBeUndefined();
    });
    it("warns and falls back when the CA file is missing", () => {
        process.env.SMTP_CA_FILE = "ca.pem";
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        expect(t._buildTlsOptions()).toBeUndefined();
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("file not found"));
    });
    it("loads the CA bundle from the certs directory", () => {
        process.env.SMTP_CA_FILE = "ca.pem";
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const read = vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("PEM"));
        expect(t._buildTlsOptions()).toEqual({ ca: Buffer.from("PEM") });
        expect(path.basename(path.dirname(String(read.mock.calls[0][0])))).toBe("certs");
        expect(logger.info).toHaveBeenCalled();
    });
    it("warns and falls back when the CA file cannot be read", () => {
        process.env.SMTP_CA_FILE = "ca.pem";
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("EACCES"); });
        expect(t._buildTlsOptions()).toBeUndefined();
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    });
});
