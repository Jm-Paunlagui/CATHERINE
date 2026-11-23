import { ProgressScope } from "../../../src/utils/progress/ProgressScope";

describe("ProgressScope reliability (wave2)", () => {
    it("a stalled child aborts only its own subtree; the parent stays alive and a late touch on the aborted child is ignored", () => {
        let t = 0;
        const now = () => t;
        const parent = new ProgressScope({ label: "req", idleLimitMs: 1000, now });
        const child = new ProgressScope({ label: "backup", idleLimitMs: 500, now, parent });
        const grandchild = new ProgressScope({ now, parent: child });
        t = 600;
        expect(child.idleMs()).toBe(600);
        child.abort(new Error("stalled"));
        expect(grandchild.aborted).toBe(true);
        expect(parent.aborted).toBe(false);
        t = 700;
        child.touch("late");
        expect(parent.lastSource).toBe("start");
        expect(parent.idleMs()).toBe(700);
    });

    it("a coalesced follower is kept alive by its leader and goes idle again after unfollow", () => {
        let t = 0;
        const now = () => t;
        const leader = new ProgressScope({ now });
        const follower = new ProgressScope({ now });
        follower.follow(leader);
        t = 900;
        leader.touch("db");
        t = 1000;
        expect(follower.idleMs()).toBe(100);
        follower.unfollow();
        expect(follower.idleMs()).toBe(1000);
    });

    it("hooks registered on a disposed-then-aborted scope never run and children detached by dispose are not aborted with the parent", () => {
        const parent = new ProgressScope();
        const kid = new ProgressScope({ parent });
        const hook = vi.fn();
        kid.onAbort(hook);
        kid.dispose();
        parent.abort(new Error("x"));
        expect(kid.aborted).toBe(false);
        kid.abort(new Error("y"));
        expect(hook).not.toHaveBeenCalled();
    });
});
