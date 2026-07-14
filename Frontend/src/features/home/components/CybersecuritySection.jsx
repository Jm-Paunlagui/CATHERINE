/**
 * CybersecuritySection.jsx — Section 2: Cybersecurity in the Age of AI.
 *
 * @param {object}   props
 * @param {object[]} props.threatStats  Stat card data array from the hook.
 */

import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { Callout } from "../../../components/shared/DocsPage";
import { Badge } from "../../../components/ui/Badge";
import { H2 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";
import StatCard from "./StatCard";

export default function CybersecuritySection({ threatStats }) {
    return (
        <section id="cybersecurity-ai" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="red" size="sm" dot pill>
                    Threat Landscape
                </Badge>
            </div>

            <H2 className="mb-4">Cybersecurity in the Age of AI</H2>

            <Paragraph>
                The software that all of us rely on every day — responsible for running banking systems, storing medical records, linking up logistics networks, keeping power grids functioning, and much more — has always contained bugs. Many are minor, but some are serious security flaws that, if discovered, could allow cyberattackers to hijack systems, disrupt operations, or steal data. According
                to the{" "}
                <a href="https://nvd.nist.gov/general/nvd-dashboard" target="_blank" rel="noopener noreferrer" className="text-(--accent-foreground) hover:underline underline-offset-2">
                    NIST National Vulnerability Database
                </a>
                , over 362,000 CVEs have been catalogued to date, with over 40,000 new vulnerabilities published in 2024 alone.
            </Paragraph>

            <Paragraph className="mt-4">
                With the latest frontier AI models, the cost, effort, and level of expertise required to find and exploit software vulnerabilities have all dropped dramatically. The{" "}
                <a href="https://www.verizon.com/business/resources/reports/dbir/" target="_blank" rel="noopener noreferrer" className="text-(--accent-foreground) hover:underline underline-offset-2">
                    Verizon 2026 Data Breach Investigations Report
                </a>{" "}
                found that 31% of all breaches now start with software vulnerabilities — surpassing stolen credentials as the top initial attack vector — and that 15 different attack techniques are now being bolstered by generative AI.
            </Paragraph>

            {/* Threat statistics grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-8 mb-8">
                {threatStats.map((stat, i) => (
                    <StatCard key={stat.label} {...stat} index={i} />
                ))}
            </div>

            <Callout tone="danger" icon={faTriangleExclamation} title="The AI Threat Multiplier">
                AI-powered attack tools can now generate sophisticated SQL injection payloads, craft polymorphic XSS vectors, and automate reconnaissance at a scale that was previously impossible. The{" "}
                <a href="https://www.ibm.com/reports/data-breach" target="_blank" rel="noopener noreferrer" className="text-danger-400 hover:underline underline-offset-2">
                    IBM Cost of a Data Breach Report 2024
                </a>{" "}
                found the global average cost of a data breach reached $4.88 million — the highest ever recorded. Web applications without defense-in-depth are sitting targets.
            </Callout>

            <Paragraph className="mt-6">
                Although the risks from AI-augmented cyberattacks are serious, there is reason for optimism: the same capabilities that make AI models dangerous in the wrong hands make them invaluable for finding and fixing flaws in important software — and for producing new software with far fewer security bugs. Project Catherine demonstrates this defensive advantage. As the{" "}
                <a href="https://www.verizon.com/business/resources/reports/dbir/" target="_blank" rel="noopener noreferrer" className="text-(--accent-foreground) hover:underline underline-offset-2">
                    Verizon DBIR
                </a>{" "}
                notes, defenders who leverage AI-powered tools can identify and remediate vulnerabilities before attackers exploit them.
            </Paragraph>
        </section>
    );
}
