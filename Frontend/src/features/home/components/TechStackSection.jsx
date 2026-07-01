/**
 * TechStackSection.jsx — Section 5: Technology Stack.
 */

import { faDatabase, faGlobe, faServer } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, staggerDelay } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import { Card } from "../../../components/ui/Card";
import { H2, H4 } from "../../../components/ui/typography/Heading";
import { List } from "../../../components/ui/typography/List";
import { Paragraph } from "../../../components/ui/typography/Paragraph";

const STACKS = [
    {
        icon: faGlobe,
        iconColor: "text-blue-400",
        iconBg: "bg-blue-400/10 dark:bg-blue-400/15 border-blue-400/20",
        title: "Frontend",
        checkColor: "text-blue-400",
        items: ["React 19 with Suspense", "Tailwind CSS v4 (Aumovio DS v3.1)", "Three-layer architecture", "HTTP-only cookie auth (CWE-287)", "DOMPurify sanitization (CWE-79)", "HttpClient-only requests (CWE-352)"],
    },
    {
        icon: faServer,
        iconColor: "text-orange-400",
        iconBg: "bg-orange-400/10 dark:bg-orange-400/15 border-orange-400/20",
        title: "Backend",
        checkColor: "text-orange-400",
        items: ["Node.js + Express v5", "Class-based OOP architecture", "14-step middleware chain", "catchAsync on every controller", "AppError standardized errors", "Structured logger (no console.log)"],
    },
    {
        icon: faDatabase,
        iconColor: "text-purple-400",
        iconBg: "bg-purple-400/10 dark:bg-purple-400/15 border-purple-400/20",
        title: "Database",
        checkColor: "text-purple-400",
        items: ["Oracle DB with oracle-mongo-wrapper", "Bind variables only (CWE-89)", "Dual-pool pattern for isolation", "Per-call counter concurrency", "Transaction with savepoints", "PoolHealthMonitor (30s interval)"],
    },
];

export default function TechStackSection() {
    return (
        <section id="tech-stack" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="cyan" size="sm" dot pill>
                    Technology
                </Badge>
            </div>

            <H2 className="mb-4">Technology Stack</H2>

            <Paragraph className="mb-6">Catherine is built on a modern, battle-tested stack chosen for security, performance, and developer experience. Every technology choice was made with defense-in-depth as the primary criterion.</Paragraph>

            <div className="grid gap-4 md:grid-cols-3">
                {STACKS.map((stack, i) => (
                    <Card key={stack.title} variant="filled" hover className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(i)}`}>
                        <div className="flex items-center gap-3 mb-3">
                            <div className={`w-8 h-8 rounded-lg border flex items-center justify-center ${stack.iconBg}`}>
                                <FontAwesomeIcon icon={stack.icon} className={`w-3.5 h-3.5 ${stack.iconColor}`} />
                            </div>
                            <H4>{stack.title}</H4>
                        </div>

                        <List variant="check" items={stack.items} size="sm" iconColor={stack.checkColor} />
                    </Card>
                ))}
            </div>
        </section>
    );
}
