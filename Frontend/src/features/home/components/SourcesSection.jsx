/**
 * SourcesSection.jsx — Section 9: Sources & References.
 *
 * All external sources cited on the home page, with links to the original reports.
 */

import { BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";
import { H2 } from "../../../components/ui/typography/Heading";
import { Paragraph } from "../../../components/ui/typography/Paragraph";

const REFERENCES = [
    {
        title: "IBM Cost of a Data Breach Report 2024",
        desc: "Global average breach cost of $4.88M — the highest ever recorded. Published by IBM Security and the Ponemon Institute.",
        url: "https://www.ibm.com/reports/data-breach",
    },
    {
        title: "NIST National Vulnerability Database (NVD)",
        desc: "Over 362,000 total CVEs catalogued. The NVD is maintained by the U.S. National Institute of Standards and Technology.",
        url: "https://nvd.nist.gov/general/nvd-dashboard",
    },
    {
        title: "Verizon 2026 Data Breach Investigations Report (DBIR)",
        desc: "31% of breaches start with software vulnerabilities; 48% involve ransomware; 15 attack techniques bolstered by generative AI.",
        url: "https://www.verizon.com/business/resources/reports/dbir/",
    },
    {
        title: "FBI Internet Crime Complaint Center (IC3) Annual Reports",
        desc: "Tracks reported cybercrime losses in the United States. The 2024 report documented record losses exceeding $16 billion.",
        url: "https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf",
    },
    {
        title: "OWASP Top 10 Web Application Security Risks",
        desc: "The industry-standard awareness document for web application security. Catherine's defenses are mapped to the full OWASP Top 10.",
        url: "https://owasp.org/www-project-top-ten/",
    },
    {
        title: "MITRE CWE (Common Weakness Enumeration)",
        desc: "Every Catherine defense is mapped to specific CWE identifiers — the community-developed list of software and hardware weakness types.",
        url: "https://cwe.mitre.org/",
    },
];

export default function SourcesSection() {
    return (
        <section id="sources" className="scroll-mt-24 mb-16">
            <H2 className="mb-6">Sources &amp; References</H2>

            <Paragraph className="mb-4">All statistics and claims on this page are sourced from authoritative, publicly available cybersecurity reports. We encourage you to verify these figures directly.</Paragraph>

            <div className="space-y-3">
                {REFERENCES.map((ref) => (
                    <a key={ref.url} href={ref.url} target="_blank" rel="noopener noreferrer" className={`block p-4 rounded-xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${TRANSITION_SMOOTH} hover:border-orange-400/30 group`}>
                        <div className="flex items-center justify-between gap-2">
                            <span className={`text-sm font-aumovio-bold ${TITLE_COLOR_TEXT}`}>{ref.title}</span>
                            <span className={`text-xs text-orange-400 ${TRANSITION_SMOOTH} group-hover:translate-x-0.5`}>↗</span>
                        </div>
                        <p className={`text-xs mt-1 ${BASE_COLOR_TEXT} opacity-70`}>{ref.desc}</p>
                    </a>
                ))}
            </div>
        </section>
    );
}
