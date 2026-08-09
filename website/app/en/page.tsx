import type { Metadata } from "next";
import { SiteShell } from "../components/SiteShell";
import { enContent } from "../site-content";

export const metadata: Metadata = {
  title: "A local AI workflow from script or footage to a publishable candidate",
  description:
    "Kacha turns a script or source media into a recoverable local project with editing, audio, captions, visual packaging, unified review, incremental revisions, and evidence-bound QC.",
  alternates: { canonical: "https://colorcross.github.io/kacha/en/" },
};

export default function EnglishHome() {
  return <SiteShell content={enContent} locale="en" />;
}
