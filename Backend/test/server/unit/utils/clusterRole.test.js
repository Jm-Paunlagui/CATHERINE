"use strict";

/**
 * @fileoverview Unit tests for ClusterRole — the pure cron-leader decision.
 * Exactly one process must run the scheduled jobs; these prove the rule for
 * single-process, leader-worker, non-leader-worker, and the fail-CLOSED
 * contract, plus the pure election-health classification server.js uses to
 * decide when to log CRITICAL.
 */

const {
    ClusterRole,
    CRON_LEADER_TRUE,
    CRON_LEADER_FALSE,
} = require("../../../../src/utils/clusterRole");

describe("ClusterRole.isCronLeader", function () {
    it("single-process (not a worker) is always the leader", function () {
        expect(ClusterRole.isCronLeader({ isWorker: false })).toBe(true);
        expect(
            ClusterRole.isCronLeader({
                isWorker: false,
                cronLeaderEnv: "false",
            }),
        ).toBe(true); // env ignored off-cluster
        expect(
            ClusterRole.isCronLeader({
                isWorker: false,
                cronLeaderEnv: undefined,
            }),
        ).toBe(true); // env ignored off-cluster, even when absent
    });

    it("the elected leader worker (CRON_LEADER=true) is the leader", function () {
        expect(
            ClusterRole.isCronLeader({
                isWorker: true,
                cronLeaderEnv: CRON_LEADER_TRUE,
            }),
        ).toBe(true);
    });

    it("a non-leader worker (CRON_LEADER=false) is NOT the leader", function () {
        expect(
            ClusterRole.isCronLeader({
                isWorker: true,
                cronLeaderEnv: CRON_LEADER_FALSE,
            }),
        ).toBe(false);
    });

    // Fail-CLOSED contract. This REPLACES the old fail-OPEN behavior — a
    // worker with a missing CRON_LEADER env used to be treated as leader
    // ("a missed sweep is worse than a duplicated one"); that theory only
    // holds when the scheduled jobs are genuinely idempotent. A job that
    // mutates state unconditionally per tick (moves rows, deducts balances,
    // sends a notification) is not safe to run N times. The contract is now
    // the opposite: a missing/malformed env on a worker must NEVER silently
    // grant leadership.
    it("fails CLOSED (NOT leader) when a worker's CRON_LEADER env is missing", function () {
        expect(
            ClusterRole.isCronLeader({
                isWorker: true,
                cronLeaderEnv: undefined,
            }),
        ).toBe(false);
    });

    it("fails CLOSED for an empty string CRON_LEADER env", function () {
        expect(
            ClusterRole.isCronLeader({ isWorker: true, cronLeaderEnv: "" }),
        ).toBe(false);
    });

    it("fails CLOSED for any value other than the exact string \"true\"", function () {
        // Case sensitivity, truthy-but-wrong strings, and near-miss typos
        // must never accidentally grant leadership.
        ["True", "TRUE", "1", "yes", "truthy", " true", "true "].forEach(
            (badValue) => {
                expect(
                    ClusterRole.isCronLeader({
                        isWorker: true,
                        cronLeaderEnv: badValue,
                    }),
                ).toBe(false);
            },
        );
    });

    it("exactly one of N forked workers is the leader (election invariant)", function () {
        // Mirror server.js: worker 0 forked as leader, rest as non-leaders.
        const envs = Array.from({ length: 8 }, (_, i) =>
            ClusterRole.cronLeaderEnv(i === 0),
        );
        const leaders = envs.filter((env) =>
            ClusterRole.isCronLeader({ isWorker: true, cronLeaderEnv: env }),
        );
        expect(leaders).toHaveLength(1);
    });

    it("cronLeaderEnv maps the boolean to the exact env strings", function () {
        expect(ClusterRole.cronLeaderEnv(true)).toBe("true");
        expect(ClusterRole.cronLeaderEnv(false)).toBe("false");
    });
});

describe("ClusterRole.electionHealth", function () {
    it("classifies exactly one leader as healthy/ok", function () {
        const result = ClusterRole.electionHealth([
            CRON_LEADER_TRUE,
            CRON_LEADER_FALSE,
            CRON_LEADER_FALSE,
        ]);
        expect(result).toEqual({
            leaderCount: 1,
            healthy: true,
            severity: "ok",
        });
    });

    it("classifies ZERO leaders as critical — the silent-starvation case fail-closed can introduce", function () {
        const result = ClusterRole.electionHealth([
            CRON_LEADER_FALSE,
            CRON_LEADER_FALSE,
        ]);
        expect(result).toEqual({
            leaderCount: 0,
            healthy: false,
            severity: "critical",
        });
    });

    it("classifies MORE THAN ONE leader as critical", function () {
        const result = ClusterRole.electionHealth([
            CRON_LEADER_TRUE,
            CRON_LEADER_TRUE,
            CRON_LEADER_FALSE,
        ]);
        expect(result).toEqual({
            leaderCount: 2,
            healthy: false,
            severity: "critical",
        });
    });

    it("treats an empty worker set as zero leaders (critical)", function () {
        expect(ClusterRole.electionHealth([])).toEqual({
            leaderCount: 0,
            healthy: false,
            severity: "critical",
        });
    });

    it("defaults to an empty array when called with no argument", function () {
        expect(ClusterRole.electionHealth()).toEqual({
            leaderCount: 0,
            healthy: false,
            severity: "critical",
        });
    });

    it("ignores malformed/undefined env entries rather than miscounting them as leaders", function () {
        const result = ClusterRole.electionHealth([
            CRON_LEADER_TRUE,
            undefined,
            "True", // wrong case — must not count
            "",
        ]);
        expect(result).toEqual({
            leaderCount: 1,
            healthy: true,
            severity: "ok",
        });
    });

    it("is pure — repeated calls with the same input produce the same output", function () {
        const envs = [CRON_LEADER_TRUE, CRON_LEADER_FALSE];
        const first = ClusterRole.electionHealth(envs);
        const second = ClusterRole.electionHealth(envs);
        expect(first).toEqual(second);
    });
});
