import type { Metadata } from "next";
import { SiteShell } from "../components/SiteShell";
import { enContent } from "../site-content";

export const metadata: Metadata = {
  title: "A local AI workflow from raw footage to a publishable cut",
  description:
    "Kacha lets Codex or Claude Code run structure edits, dialogue cleanup, caption calibration, visual packaging, incremental revisions, and QC in one local-first workflow.",
  alternates: { canonical: "https://colorcross.github.io/kacha/en/" },
};

export default function EnglishHome() {
  return <SiteShell content={enContent} locale="en" />;
}
