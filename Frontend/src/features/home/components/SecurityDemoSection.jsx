/**
 * SecurityDemoSection.jsx — Section 3: Catherine Security Demo.
 *
 * Contains both the static attack-category cards AND a live interactive
 * demo panel that fires real HTTP requests against the running backend.
 *
 * @param {object}   props
 * @param {object[]} props.attackDemos  Attack demo card data from the hook.
 */

import { faCircleCheck } from "@fortawesome/free-solid-svg-icons";
import { Callout } from "../../../components/shared/DocsPage";
import { Badge } from "../../../components/ui/Badge";
import { H2, H3 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";
import { useSecurityDemo } from "../securityDemo.hook";
import AttackDemoCard from "./AttackDemoCard";
import LiveDemoPanel from "./LiveDemoPanel";

export default function SecurityDemoSection({ attackDemos }) {
    const demo = useSecurityDemo();

    return (
        <section id="security-demo" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="purple" size="sm" dot pill>
                    Live Defense
                </Badge>
            </div>

            <H2 className="mb-4">Catherine Security Demo</H2>

            <Paragraph>Catherine's security architecture has been tested against real-world attack vectors. Below are the categories of attacks that Catherine's middleware chain detects, blocks, and logs — each mapped to its corresponding CWE identifier and severity rating.</Paragraph>

            {/* Attack demo cards */}
            <div className="grid gap-4 md:grid-cols-2 mt-8">
                {attackDemos.map((attack, i) => (
                    <AttackDemoCard key={attack.title} {...attack} index={i} />
                ))}
            </div>

            {/* ── Live interactive demo ────────────────────────────────── */}
            <H3 className="mt-10 mb-4">Try It Yourself — Live Security Demo</H3>

            <Paragraph className="mb-2">
                Don't take our word for it — fire real attack payloads against the running Catherine backend and see the actual middleware responses. Select a scenario, hit <strong>Fire Request</strong>, and watch the SecurityFilterMiddleware block it in real time.
            </Paragraph>

            <LiveDemoPanel {...demo} />

            <div className="mt-8" />

            <Callout tone="success" icon={faCircleCheck} title="Defense in Depth">
                Even if an attacker bypasses the SecurityFilterMiddleware, Catherine has multiple additional layers: bind-variable-only Oracle queries (no string interpolation), parameterized oracle-mongo-wrapper pipelines, rate limiting, CSRF protection, and comprehensive input validation — all working together to ensure no single point of failure.
            </Callout>
        </section>
    );
}
