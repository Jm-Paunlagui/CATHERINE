/**
 * @fileoverview Shared supertest helpers for the purge / integrity / changelog
 * HTTP suites: role tokens and a CSRF-aware agent.
 */
import request from "supertest";
import app from "../../../src/app";

const { signToken } = require("./auth");

export const superAdminToken = () => signToken({ sub: "SA001", userId: "SA001", id: 1, role: "SUPER_ADMIN", userLevel: 3 });
export const adminToken = () => signToken({ sub: "ADM001", userId: "ADM001", id: 2, role: "ADMIN", userLevel: 2 });
export const userToken = () => signToken({ sub: "USR001", userId: "USR001", id: 3, role: "USER", userLevel: 1 });

export async function csrfAgent() {
    const agent = request.agent(app);
    const res = await agent.get("/api/v1/csrf/token");
    return { agent, csrf: (res.body?.token ?? "") as string };
}

type Method = "get" | "post" | "put" | "delete";

/** Sends one request with optional bearer token and a valid CSRF token on mutating verbs. */
export async function send(method: Method, path: string, opts: { bearer?: string; body?: unknown } = {}) {
    const { agent, csrf } = await csrfAgent();
    let req = agent[method](path);
    if (opts.bearer !== undefined) req = req.set("Authorization", `Bearer ${opts.bearer}`);
    if (method !== "get") req = req.set("x-csrf-token", csrf);
    if (opts.body !== undefined) req = req.send(opts.body as object);
    return req;
}
