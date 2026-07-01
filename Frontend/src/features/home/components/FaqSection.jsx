/**
 * FaqSection.jsx — Section 8: Frequently Asked Questions.
 *
 * @param {object}   props
 * @param {object[]} props.faqItems  Accordion data from the hook.
 */

import { Accordion } from "../../../components/ui/Accordion";
import { Badge } from "../../../components/ui/Badge";
import { H2 } from "../../../components/ui/typography/Heading";

export default function FaqSection({ faqItems }) {
    return (
        <section id="faq" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="grey" size="sm" pill>
                    FAQ
                </Badge>
            </div>

            <H2 className="mb-6">Frequently Asked Questions</H2>

            <Accordion items={faqItems} variant="separated" size="md" />
        </section>
    );
}
