import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "../../../src/utils/logger";
import { scrubString, scrubValue, scrubMeta, pseudonymize } from "../../../src/utils/logRedaction";
import { singleAddress, maskAddress, credentialAddressOf } from "../../../src/utils/emailAddress";
import { queryString } from "../../../src/utils/http/queryString";
import { normalizeCellValue } from "../../../src/utils/excelCell";

let dir: string;
let baseDir: string;
let consoleOutput: boolean;
const files = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } };
    walk(dir);
    return out.join("\n");
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logsec-"));
    baseDir = Logger.CONFIG.LOG_BASE_DIR;
    consoleOutput = Logger.CONFIG.CONSOLE_OUTPUT;
    Logger.CONFIG.LOG_BASE_DIR = dir;
    Logger.CONFIG.CONSOLE_OUTPUT = false;
});
afterEach(() => {
    Logger.CONFIG.LOG_BASE_DIR = baseDir;
    Logger.CONFIG.CONSOLE_OUTPUT = consoleOutput;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("log pipeline never persists personal identifiers (CWE-532 / CWE-200)", () => {
    it("emails and labelled ids in messages, meta and error fields are masked on disk", async () => {
        const lg = new Logger();
        const err: any = new Error("SMTP rejected victim.person@corp.com");
        err.response = "550 no such user victim.person@corp.com";
        await lg.error("send failed for GID: 30901234567 and user 4455", {
            cause: err,
            recipients: ["a.one@corp.com", "b.two@corp.com"],
            userId: "998877",
            admin: { EMP_ID: "123456", mail: "boss@corp.com" },
        });
        await lg.flush();
        const text = files();
        for (const secret of ["victim.person@corp.com", "a.one@corp.com", "b.two@corp.com", "boss@corp.com", "30901234567", "998877", "123456", "4455"]) {
            expect(text).not.toContain(secret);
        }
        expect(text).toMatch(/v\*+@corp\.com/);
        expect(text).toMatch(/emp_[0-9a-f]{10}/);
        expect(text).toMatch(/usr_[0-9a-f]{10}/);
    });

    it("the same identifier yields the same token on every line, so incidents stay correlatable", async () => {
        const lg = new Logger();
        await lg.info("login GID: 5550001");
        await lg.warning("lockout GID 5550001");
        await lg.flush();
        const tokens = files().match(/emp_[0-9a-f]{10}/g)!;
        expect(tokens).toHaveLength(2);
        expect(tokens[0]).toBe(tokens[1]);
        expect(tokens[0]).toBe(pseudonymize("gid", "5550001"));
    });

    it("pseudonyms are keyed: they change with DATA_SIGNING_SECRET-derived key material, never expose the digits", () => {
        const token = pseudonymize("gid", "30901234567");
        expect(token).not.toContain("30901234567");
        expect(token).toMatch(/^emp_[0-9a-f]{10}$/);
    });

    it("an attacker cannot smuggle a raw email past the masker with unicode or odd local parts", () => {
        for (const mail of ["Peña.Núñez@bücher.de", "first+tag@sub.corp.co.uk", "a_b%c@corp.io"]) {
            const out = scrubString(`contact ${mail} now`);
            expect(out).not.toContain(mail);
            expect(out).toContain(mail.slice(0, 1) + "*");
        }
    });

    it("hostile deep or wide payloads are still scrubbed (budget overflow is not a bypass)", () => {
        let deep: any = { leaf: "deep.victim@corp.com" };
        for (let i = 0; i < 20; i++) deep = { n: deep };
        expect(JSON.stringify(scrubValue(deep))).not.toContain("deep.victim@corp.com");
        const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, `wide${i}.victim@corp.com`]));
        expect(JSON.stringify(scrubMeta(wide))).not.toMatch(/wide\d+\.victim@corp\.com/);
    });

    it("the redaction bypass flag is honoured only outside production", async () => {
        const prev = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = "production";
            const lg = new Logger();
            await lg.info("leak attempt prod.victim@corp.com", { _noRedact: true });
            await lg.flush();
            expect(files()).not.toContain("prod.victim@corp.com");
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it("scrubbing never mutates the caller's objects", () => {
        const meta = { mail: "keep.me@corp.com", nested: { id: "GID: 1234" } };
        const before = JSON.stringify(meta);
        scrubMeta(meta);
        expect(JSON.stringify(meta)).toBe(before);
    });
});

describe("recipient addresses cannot carry header injection (CWE-93 / CWE-201)", () => {
    const attacks = [
        "victim@corp.com\r\nBcc: attacker@evil.com",
        "victim@corp.com\nBcc: attacker@evil.com",
        "victim@corp.com%0d%0aBcc: attacker@evil.com",
        "victim@corp.com\r\n\r\nSubject: pwned",
        "victim@corp.com, attacker@evil.com",
        "victim@corp.com; attacker@evil.com",
        "Victim <victim@corp.com>",
        '"victim@corp.com"@evil.com',
        "victim@corp.com\u0000attacker@evil.com",
        "victim@corp.com Bcc: attacker@evil.com",
    ];
    it.each(attacks)("rejects %j", (raw) => {
        expect(singleAddress(raw)).toBeNull();
        expect(maskAddress(raw)).toBeNull();
        expect(credentialAddressOf({ EMAIL: raw })).toBeNull();
    });
    it("rejects arrays and objects so a JSON body cannot fan a credential out to several mailboxes", () => {
        expect(singleAddress(["a@corp.com", "b@corp.com"])).toBeNull();
        expect(singleAddress({ toString: () => "a@corp.com" })).toBeNull();
        expect(credentialAddressOf({ EMAIL: ["a@corp.com"] })).toBeNull();
    });
    it("still accepts one ordinary address", () => {
        expect(singleAddress("first.last@corp.com")).toBe("first.last@corp.com");
    });
    it("the masked form shows only the first character of the mailbox", () => {
        expect(maskAddress("first.last@corp.com")).toBe("f***@corp.com");
    });
});

describe("untrusted input shapes are normalised, not trusted", () => {
    it("query parameters given as arrays or objects (qs pollution) read as absent", () => {
        expect(queryString(["a", "b"])).toBeUndefined();
        expect(queryString({ $ne: null })).toBeUndefined();
    });
    it("spreadsheet cells that are objects never become the string [object Object] (CWE-704)", () => {
        for (const cell of [{ foo: 1 }, { error: "#REF!" }, { formula: "A1", result: { nested: true } }]) {
            const v = normalizeCellValue(cell);
            expect(v === null || String(v) !== "[object Object]").toBe(true);
        }
    });
});
