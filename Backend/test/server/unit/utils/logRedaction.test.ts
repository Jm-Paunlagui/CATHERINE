import { scrubString, scrubValue, scrubMeta, pseudonymize, searchCandidates, maskEmail } from "../../../../src/utils/logRedaction";

const TOKEN = /^(emp|usr)_[0-9a-f]{10}$/;

describe("maskEmail", () => {
    it("masks the local part, keeps the domain", () => expect(maskEmail("johndoe@example.com")).toBe("j******@example.com"));
    it("masks every element of an array (no comma-join leak)", () => {
        expect(maskEmail(["a@example.com", "bee@example.com"])).toEqual(["a*@example.com", "b**@example.com"]);
    });
    it("returns *** for values without a usable local part", () => {
        expect(maskEmail("nope")).toBe("***");
        expect(maskEmail("@x.com")).toBe("***");
        expect(maskEmail(undefined as never)).toBe("***");
    });
});

describe("pseudonymize", () => {
    it("is deterministic, prefixed per class, and class-separated", () => {
        expect(pseudonymize("gid", "12345")).toBe(pseudonymize("gid", "12345"));
        expect(pseudonymize("gid", "12345")).toMatch(/^emp_[0-9a-f]{10}$/);
        expect(pseudonymize("empid", 12345)).toMatch(/^emp_/);
        expect(pseudonymize("userid", "12345")).toMatch(/^usr_/);
        expect(pseudonymize("gid", "12345")).not.toBe(pseudonymize("empid", "12345"));
        expect(pseudonymize("other", "1")).toMatch(/^usr_/);
    });
    it("is keyed: the raw value never appears in the token", () => {
        expect(pseudonymize("gid", "30901234567")).not.toContain("30901234567");
    });
});

describe("scrubString", () => {
    it.each([
        ["GID: 12345678901", "GID: "],
        ["gid 123", "gid "],
        ['{"GID":"4567"}', '{"GID":"'],
        ["GID=88", "GID="],
        ["GID#99", "GID#"],
        ["GID123", "GID"],
        ["EMP_ID: 555", "EMP_ID: "],
        ["ADMIN_ID 77", "ADMIN_ID "],
        ["USERID: 4242", "USERID: "],
        ["USERNAME: 4242", "USERNAME: "],
        ["for user 9876", "for user "],
        ["user: 321", "user: "],
    ])("pseudonymises the digits in %s and keeps the label", (input, label) => {
        const out = scrubString(input);
        const digits = input.slice(label.length).match(/\d+/)![0];
        expect(out.startsWith(label)).toBe(true);
        expect(out).not.toContain(digits);
        expect(out.slice(label.length)).toMatch(/^(emp|usr)_[0-9a-f]{10}/);
    });
    it("tokenises each element of a GIDs list", () => {
        const out = scrubString("GIDs: 11, 22 ,33 done");
        expect(out.match(/emp_[0-9a-f]{10}/g)).toHaveLength(3);
        expect(out.endsWith(" done")).toBe(true);
    });
    it("a GID and the same digits as USERID give different tokens; same class is stable", () => {
        expect(scrubString("GID: 4242")).toBe(scrubString("GID: 4242"));
        expect(scrubString("GID: 4242").slice(5)).not.toBe(scrubString("USERID: 4242").slice(8));
    });
    it("masks bare emails (including unicode) in free text", () => {
        expect(scrubString("send failed for jdoe@corp.com: 550")).toBe("send failed for j***@corp.com: 550");
        expect(scrubString("Peña@bücher.de")).toBe("P***@bücher.de");
    });
    it("leaves unlabelled numbers, short ids, and alphanumeric usernames alone, by reference", () => {
        for (const s of ["rows: 12345", "GID: 7", "USERNAME: jdoe", "the user is admin", "GIDX 123", "plain"]) {
            expect(scrubString(s)).toBe(s);
        }
    });
});

describe("scrubValue", () => {
    it("passes primitives through", () => {
        expect(scrubValue(5)).toBe(5);
        expect(scrubValue(null)).toBeNull();
        expect(scrubValue(undefined)).toBeUndefined();
        expect(scrubValue(true)).toBe(true);
    });
    it("walks arrays and objects without mutating the input", () => {
        const input = { msg: "a@b.org", list: ["GID: 123"], n: { deep: "USERID 99" } };
        const copy = JSON.stringify(input);
        const out = scrubValue(input) as any;
        expect(JSON.stringify(input)).toBe(copy);
        expect(out.msg).toBe("a*@b.org");
        expect(out.list[0]).toMatch(/emp_/);
        expect(out.n.deep).toMatch(/usr_/);
    });
    it("pseudonymises a bare id under identifier-named keys (cased/underscored/dashed) to the labelled-form token", () => {
        const out = scrubValue({ userId: "30901", GID: 12345, "emp-id": 777, admin_id: "88", gids: [11, "22", "x", 3], gid: "abc", other: 12345 }) as any;
        expect(out.userId).toBe(pseudonymize("userid", "30901"));
        expect(out.GID).toBe(pseudonymize("gid", "12345"));
        expect(out["emp-id"]).toBe(pseudonymize("empid", "777"));
        expect(out.admin_id).toBe(pseudonymize("empid", "88"));
        expect(out.gids[0]).toBe(pseudonymize("gid", "11"));
        expect(out.gids[1]).toBe(pseudonymize("gid", "22"));
        expect(out.gids[2]).toBe("x");
        expect(out.gids[3]).toBe(3);
        expect(out.gid).toBe("abc");
        expect(out.other).toBe(12345);
        expect(out.GID).toMatch(TOKEN);
    });
    it("returns opaque built-ins by reference", () => {
        const d = new Date();
        const b = Buffer.from("a@b.org");
        const m = new Map();
        expect(scrubValue(d)).toBe(d);
        expect(scrubValue(b)).toBe(b);
        expect(scrubValue(m)).toBe(m);
        const st = new Set([1]);
        expect(scrubValue(st)).toBe(st);
        expect(scrubValue(/x/)).toBeInstanceOf(RegExp);
        expect(scrubValue(Promise.resolve())).toBeInstanceOf(Promise);
        expect(scrubValue(new ArrayBuffer(1))).toBeInstanceOf(ArrayBuffer);
    });
    it("scrubs Error message, stack and enumerable fields (nodemailer-style) while keeping the prototype", () => {
        class MailError extends Error { response = "550 rejected victim@corp.com"; rejected = ["victim@corp.com"]; }
        const e = new MailError("cannot send to victim@corp.com");
        e.stack = "Error at victim@corp.com";
        const out = scrubValue(e) as MailError;
        expect(out).toBeInstanceOf(MailError);
        expect(out.message).toBe("cannot send to v*****@corp.com");
        expect(out.stack).toBe("Error at v*****@corp.com");
        expect(out.response).toContain("v*****@corp.com");
        expect(out.rejected[0]).toBe("v*****@corp.com");
        expect(JSON.stringify(out)).not.toContain("victim");
    });
    it("scrubs a class instance's own properties (non-Error, non-string message skipped)", () => {
        class Box { owner = "x@y.org"; }
        const e: any = new Error("m");
        Object.defineProperty(e, "stack", { value: 5, configurable: true });
        expect((scrubValue(new Box()) as Box).owner).toBe("x*@y.org");
        expect((scrubValue(e) as Error).message).toBe("m");
    });
    it("beyond depth the subtree is replaced by scrubbed JSON text, never copied raw", () => {
        let v: any = { leaf: "secret@corp.com" };
        for (let i = 0; i < 8; i++) v = { n: v };
        const out = JSON.stringify(scrubValue(v));
        expect(out).not.toContain("secret@corp.com");
        expect(out).toContain("s*****@corp.com");
    });
    it("beyond the node budget everything is still scrubbed", () => {
        const wide: Record<string, string> = {};
        for (let i = 0; i < 400; i++) wide[`k${i}`] = `user${i}@corp.com`;
        const out = scrubValue(wide) as Record<string, unknown>;
        expect(JSON.stringify(out)).not.toMatch(/user\d+@corp\.com/);
        const arr = Array.from({ length: 400 }, (_, i) => ({ e: `u${i}@corp.com` }));
        expect(JSON.stringify(scrubValue(arr))).not.toMatch(/u\d+@corp\.com/);
        const strs = Array.from({ length: 400 }, (_, i) => `u${i}@corp.com`);
        expect(JSON.stringify(scrubValue(strs))).not.toMatch(/u\d+@corp\.com/);
    });
    it("over-budget paths cope with cycles, unserialisable values, opaque values and primitives", () => {
        const wide: any = {};
        for (let i = 0; i < 205; i++) wide[`k${i}`] = i;
        wide.cyc = { a: "x@y.org" };
        wide.cyc.self = wide.cyc;
        wide.big = { b: BigInt(1) };
        wide.date = new Date(0);
        wide.num = 5;
        wide.fn = () => 1;
        wide.str = "gid: 1234";
        wide.nul = null;
        const out = scrubValue(wide) as any;
        expect(JSON.stringify(out.cyc)).toContain("Circular Reference");
        expect(out.big).toBe("[Unserialisable]");
        expect(out.date).toBeInstanceOf(Date);
        expect(out.num).toBe(5);
        expect(out.fn).toBeTypeOf("function");
        expect(out.str).toMatch(/emp_/);
        expect(out.nul).toBeNull();
    });
    it("a deep array is scrubbed through the depth budget", () => {
        let v: any = ["a@b.org"];
        for (let i = 0; i < 8; i++) v = [v];
        expect(JSON.stringify(scrubValue(v))).not.toContain("a@b.org");
    });
});

describe("scrubMeta", () => {
    it("returns a clone and leaves internal and underscore keys untouched", () => {
        const meta = { _clientMachine: "jdoe@4242 (C) 10.0.0.1", _noRedact: true, method: "POST", url: "/a?e=a@b.org", function: "f", file: "x.ts", line: 3, user: "a@b.org" };
        const out = scrubMeta(meta);
        expect(out).not.toBe(meta);
        expect(out._clientMachine).toBe(meta._clientMachine);
        expect(out.url).toBe(meta.url);
        expect(out.user).toBe("a*@b.org");
        expect(meta.user).toBe("a@b.org");
    });
    it("returns non-objects unchanged", () => {
        expect(scrubMeta(null as never)).toBeNull();
        expect(scrubMeta("x" as never)).toBe("x");
    });
});

describe("searchCandidates", () => {
    it("returns just the needle when not numeric", () => expect(searchCandidates("abc")).toEqual(["abc"]));
    it("adds the three class tokens for a digits-only needle", () => {
        const c = searchCandidates("30901");
        expect(c).toEqual(["30901", pseudonymize("gid", "30901"), pseudonymize("empid", "30901"), pseudonymize("userid", "30901")]);
        expect(searchCandidates("7")).toEqual(["7"]);
    });
});
