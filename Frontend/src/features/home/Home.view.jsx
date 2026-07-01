/**
 * Home.view.jsx — Project Catherine landing page.
 *
 * Inspired by Anthropic's Project Glasswing announcement page, adapted to the
 * Aumovio Design System v3.1. A long-form, section-based narrative page that
 * introduces Project Catherine — securing critical web apps for the AI era.
 *
 * Uses the DocShell layout (left article + right "On this page" rail) for
 * consistent documentation-style navigation with scroll-spy.
 *
 * Architecture: pure view — all data lives in the hook, section-level rendering
 * is extracted into sibling components/ folder. Each component receives data
 * via props — none import the hook or API files directly.
 */

import { ErrorBoundary } from "../../components/feedback/ErrorBoundary";
import { DocShell, WhereToGoNext } from "../../components/shared/DocsPage";
import { Banner } from "../../components/ui/Banner";
import { Divider } from "../../components/ui/typography/Divider";
import { H2 } from "../../components/ui/typography/Heading";
import ArchitectureSection from "./components/ArchitectureSection";
import BenchmarksSection from "./components/BenchmarksSection";
import CybersecuritySection from "./components/CybersecuritySection";
import FaqSection from "./components/FaqSection";
import HeroSection from "./components/HeroSection";
import IntroductionSection from "./components/IntroductionSection";
import RoadmapSection from "./components/RoadmapSection";
import SecurityDemoSection from "./components/SecurityDemoSection";
import SourcesSection from "./components/SourcesSection";
import TechStackSection from "./components/TechStackSection";
import { useHome } from "./home.hook";

// ─────────────────────────────────────────────────────────────────────────────
// Main view — composes section components with data from the hook
// ─────────────────────────────────────────────────────────────────────────────

function HomeContent() {
    const { sections, announcement, threatStats, attackDemos, defenseLayers, middlewareSteps, roadmapItems, faqItems, nextLinks } = useHome();

    return (
        <>
            {/* ── Announcement banner ─────────────────────────────────── */}
            <Banner variant="promo" sticky dismissible>
                Project Catherine — An open-source cybersecurity-hardened web application template for the AI era.
            </Banner>

            {/* ── Hero ────────────────────────────────────────────────── */}
            <HeroSection announcement={announcement} />

            {/* ── Article body (DocShell provides "On this page" rail) ─ */}
            <DocShell sections={sections}>
                {/* §1 — Introduction */}
                <IntroductionSection />

                <Divider variant="gradient" spacing="lg" />

                {/* §2 — Cybersecurity in the Age of AI */}
                <CybersecuritySection threatStats={threatStats} />

                <Divider variant="gradient" spacing="lg" />

                {/* §3 — Catherine Security Demo */}
                <SecurityDemoSection attackDemos={attackDemos} />

                <Divider variant="gradient" spacing="lg" />

                {/* §4 — Architecture & Defense Layers */}
                <ArchitectureSection middlewareSteps={middlewareSteps} defenseLayers={defenseLayers} />

                <Divider variant="gradient" spacing="lg" />

                {/* §5 — Technology Stack */}
                <TechStackSection />

                <Divider variant="gradient" spacing="lg" />

                {/* §6 — Security Coverage */}
                <BenchmarksSection />

                <Divider variant="gradient" spacing="lg" />

                {/* §7 — Plans for Project Catherine */}
                <RoadmapSection roadmapItems={roadmapItems} />

                <Divider variant="gradient" spacing="lg" />

                {/* §8 — FAQ */}
                <FaqSection faqItems={faqItems} />

                <Divider variant="gradient" spacing="lg" />

                {/* §9 — Sources & References */}
                <SourcesSection />

                <Divider variant="gradient" spacing="lg" />

                {/* §10 — Where to Go Next */}
                <section id="next" className="scroll-mt-24 mb-8">
                    <H2 className="mb-6">Where to Go Next</H2>
                    <WhereToGoNext items={nextLinks} />
                </section>
            </DocShell>
        </>
    );
}

export default function HomeView() {
    return (
        <ErrorBoundary>
            <HomeContent />
        </ErrorBoundary>
    );
}
