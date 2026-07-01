/**
 * BenchmarksSection.jsx — Section 6: Security Coverage benchmarks.
 */

import { BASE_COLOR_BG, STANDARD_BORDER, TITLE_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import { Progress } from "../../../components/ui/Progress";
import { H2 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";

const BENCHMARKS = [
    { label: "OWASP Top 10 Coverage", badge: "10/10", badgeVariant: "green", value: 100, variant: "success" },
    { label: "CWE Coverage (Frontend)", badge: "8 CWEs", badgeVariant: "blue", value: 95, variant: "primary" },
    { label: "Middleware Branch Coverage", badge: "90%+", badgeVariant: "purple", value: 92, variant: "purple" },
    { label: "Security Header Compliance", badge: "A+", badgeVariant: "green", value: 100, variant: "gradient" },
];

export default function BenchmarksSection() {
    return (
        <section id="benchmarks" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="green" size="sm" dot pill>
                    Benchmarks
                </Badge>
            </div>

            <H2 className="mb-4">Security Coverage</H2>

            <Paragraph className="mb-6">Catherine's security posture is measured against industry-standard frameworks. Every middleware class targets 90%+ branch coverage, and the entire security surface is tested with adversarial inputs.</Paragraph>

            <div className="space-y-5">
                {BENCHMARKS.map((b) => (
                    <div key={b.label} className={`p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER}`}>
                        <div className="flex items-center justify-between mb-2">
                            <span className={`text-sm font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{b.label}</span>
                            <Badge variant={b.badgeVariant} size="xs">
                                {b.badge}
                            </Badge>
                        </div>

                        <Progress value={b.value} variant={b.variant} size="md" animated />
                    </div>
                ))}
            </div>
        </section>
    );
}
