/**
 * ArchitectureSection.jsx — Section 4: Architecture & Defense Layers.
 *
 * @param {object}   props
 * @param {object[]} props.middlewareSteps  Stepper data for the 14-step chain.
 * @param {object[]} props.defenseLayers   Defense layer card data.
 */

import { BASE_COLOR_BG, STANDARD_BORDER } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../../components/ui/Badge";
import { Stepper } from "../../../components/ui/Stepper";
import { H2, H3 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";
import DefenseLayerCard from "./DefenseLayerCard";

export default function ArchitectureSection({ middlewareSteps, defenseLayers }) {
    return (
        <section id="architecture" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="blue" size="sm" dot pill>
                    Architecture
                </Badge>
            </div>

            <H2 className="mb-4">Architecture &amp; Defense Layers</H2>

            <Paragraph>Catherine's security is not a single feature — it's an architecture. Every layer of the stack has been hardened with specific, measurable defenses mapped to CWE identifiers. The 14-step middleware chain is immutable and positionally ordered for maximum security.</Paragraph>

            {/* Middleware chain stepper */}
            <H3 className="mt-8 mb-4">The 14-Step Middleware Chain</H3>

            <Paragraph className="mb-6">The order of middleware is not arbitrary — each position is chosen for a specific security reason. Security headers go first, scanner blocking happens before body parsing, and rate limiting is the last gate before route handlers.</Paragraph>

            <div className={`p-6 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER} mb-8`}>
                <Stepper steps={middlewareSteps} current={middlewareSteps.length} variant="numbered" orientation="vertical" />
            </div>

            {/* Defense layer cards */}
            <H3 className="mt-8 mb-6">Four Pillars of Defense</H3>

            <div className="grid gap-6 md:grid-cols-2">
                {defenseLayers.map((layer, i) => (
                    <DefenseLayerCard key={layer.title} {...layer} index={i} />
                ))}
            </div>
        </section>
    );
}
