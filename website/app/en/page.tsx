import type { Metadata } from "next";
import { SiteShell } from "../components/SiteShell";
import { enContent } from "../site-content";

export const metadata: Metadata = {
  title: "Local-first professional AI video workflow",
  description:
    "Kacha turns video planning, editing, sound, visuals, captions, revisions, and QC into an auditable local workflow.",
  alternates: { canonical: "/en" },
};

export default function EnglishHome() {
  return <SiteShell content={enContent} locale="en" />;
}
