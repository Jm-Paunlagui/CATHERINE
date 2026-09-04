/**
 * setup.js — global test bootstrap, loaded once by vitest (setupFiles).
 *
 * Wires three things every test file relies on:
 *
 *   1. jest-dom matchers  — `toBeInTheDocument`, `toHaveClass`, … on `expect`.
 *   2. RTL auto-cleanup   — unmount every rendered tree after each test so DOM
 *                            state and effects never leak into the next test.
 *   3. MSW lifecycle      — one node server for the whole run:
 *        listen({ onUnhandledRequest: "error" }) → an un-stubbed request is a
 *          test bug, not a silent pass-through to a real backend.
 *        resetHandlers() after each test → per-test `server.use(...)` overrides
 *          never bleed into the next test.
 *        close() at the end → no dangling interceptor between runs.
 *
 * Pure-function suites (e.g. the money formatter tests) do not hit the network;
 * the MSW server sits idle for them and costs nothing.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/server";

beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
    cleanup();
    server.resetHandlers();
});

afterAll(() => {
    server.close();
});
