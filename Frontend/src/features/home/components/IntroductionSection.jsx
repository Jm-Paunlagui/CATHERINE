/**
 * IntroductionSection.jsx — Section 1: What Project Catherine is and why it exists.
 */

import { GRADIENT_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import { Blockquote } from "../../../components/ui/typography/Blockquote";
import { H2 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";

export default function IntroductionSection() {
    return (
        <section id="introduction" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="orange" size="sm" dot pill>
                    Introduction
                </Badge>
            </div>

            <H2 className="mb-4">Introduction</H2>

            <time className="text-sm text-grey-400 font-aumovio-bold block mb-6">July 1, 2026</time>

            <Paragraph lead>
                Today we're announcing <strong className={GRADIENT_COLOR_TEXT}>Project Catherine</strong>, a comprehensive cybersecurity-hardened web application template that demonstrates how modern full-stack applications should be built to withstand the evolving threat landscape of the AI era.
            </Paragraph>

            <Paragraph className="mt-4">
                We built Project Catherine because of a stark reality: AI models have reached a level of coding capability where they can discover and exploit software vulnerabilities faster than most human security teams can patch them. The fallout — for businesses, public safety, and data integrity — could be severe. Catherine is an urgent attempt to demonstrate what a properly defended web
                application looks like.
            </Paragraph>

            <Paragraph className="mt-4">As part of Project Catherine, we've implemented a 14-layer middleware security chain, class-based OOP backend architecture with Express v5, a React 19 frontend with the Aumovio Design System v3.1, and Oracle database integration through the oracle-mongo-wrapper — all hardened against the OWASP Top 10 and mapped to specific CWE identifiers.</Paragraph>

            <Blockquote cite="John Moises Paunlagui — Creator, Project Catherine" variant="card">
                No one developer can solve cybersecurity alone. Catherine is a starting point — a template that shows how every layer of a modern web application can be fortified. The work of defending our digital infrastructure takes years; AI capabilities advance in months. For defenders to come out ahead, we need to build secure by default.
            </Blockquote>
        </section>
    );
}
