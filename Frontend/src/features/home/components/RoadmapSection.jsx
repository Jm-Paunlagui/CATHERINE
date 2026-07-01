/**
 * RoadmapSection.jsx — Section 7: Plans for Project Catherine.
 *
 * @param {object}   props
 * @param {object[]} props.roadmapItems  Timeline data from the hook.
 */

import { faRocket } from "@fortawesome/free-solid-svg-icons";
import { Callout } from "../../../components/shared/DocsPage";
import { Badge } from "../../../components/ui/Badge";
import { Timeline } from "../../../components/ui/Timeline";
import { H2 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";
import { BADGE_STATUS } from "../home.hook";

export default function RoadmapSection({ roadmapItems }) {
    return (
        <section id="plans" className="scroll-mt-24 mb-16">
            <div className="flex items-center gap-3 mb-2">
                <Badge variant="orange" size="sm" dot pill>
                    Roadmap
                </Badge>
            </div>

            <H2 className="mb-4">Plans for Project Catherine</H2>

            <Paragraph>Today's release is the beginning of a longer-term effort. To be successful, it will require contributions from the security community and continuous adaptation to emerging threats.</Paragraph>

            <Paragraph className="mt-4 mb-8">Project Catherine will continue to evolve with new security features, expanded test coverage, and integration with emerging AI-powered defense tools. Here is our roadmap:</Paragraph>

            <Timeline
                items={roadmapItems.map((item) => {
                    const status = BADGE_STATUS[item.badgeStatus];
                    return {
                        ...item,
                        badge: status ? (
                            <Badge variant={status.color === "success" ? "green" : status.color} size="xs" pill>
                                {status.label}
                            </Badge>
                        ) : null,
                    };
                })}
                variant="left"
                connect
            />

            <Callout tone="blue" icon={faRocket} title="Open Source & Community">
                Project Catherine is designed to be a community resource. We invite security researchers, developers, and organizations to contribute, audit, and extend the template. Every contribution makes the entire ecosystem more secure. The work of defending web infrastructure takes years; AI capabilities advance in months. For defenders to come out ahead, we need to build together.
            </Callout>
        </section>
    );
}
