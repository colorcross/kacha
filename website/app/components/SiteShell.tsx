import { CopyInstall } from "./CopyInstall";
import { LogoMark } from "./LogoMark";
import type { SiteContent } from "../site-content";

const installCommand =
  "curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh | bash -s -- --agent codex";
const siteBasePath = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? "";

export function SiteShell({
  content,
  locale,
}: {
  content: SiteContent;
  locale: "zh" | "en";
}) {
  return (
    <main lang={locale === "zh" ? "zh-CN" : "en"}>
      <header className="site-header">
        <a className="brand-lockup" href="#top" aria-label={content.brandHome}>
          <LogoMark compact />
          <span className="brand-wordmark">KACHA</span>
          <span className="brand-cn">咔嚓</span>
        </a>
        <nav aria-label={content.navLabel}>
          <a href="#system">{content.nav.system}</a>
          <a href="#workflow">{content.nav.workflow}</a>
          <a href="#principles">{content.nav.principles}</a>
          <a href="#install">{content.nav.install}</a>
        </nav>
        <div className="header-actions">
          <a
            className="language-link"
            href={`${siteBasePath}${locale === "zh" ? "/en/" : "/"}`}
            lang={locale === "zh" ? "en" : "zh-CN"}
          >
            {locale === "zh" ? "EN" : "中文"}
          </a>
          <a
            className="header-github"
            href="https://github.com/colorcross/kacha"
            rel="noreferrer"
            target="_blank"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-cut-line" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="signal-dot" />
            {content.hero.eyebrow}
          </p>
          <h1>
            <span className="hero-title-lead">{content.hero.titleLead}</span>
            <br />
            <span className="hero-title-accent">{content.hero.titleAccent}</span>
          </h1>
          <p className="hero-summary">{content.hero.summary}</p>
          <div className="hero-actions">
            <a className="button button--primary" href="#install">
              {content.hero.primaryCta}
              <span aria-hidden="true">↓</span>
            </a>
            <a
              className="button button--quiet"
              href="https://github.com/colorcross/kacha"
              rel="noreferrer"
              target="_blank"
            >
              {content.hero.secondaryCta}
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="hero-contract">
            {content.hero.contracts.map((item, index) => (
              <span key={item}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="hero-visual" aria-label={content.hero.visualLabel}>
          <div className="hero-logo-plane">
            <LogoMark />
            <p>
              LOCAL
              <br />
              VIDEO
              <br />
              SYSTEM
            </p>
          </div>
          <div className="timeline-console">
            <div className="console-head">
              <span>KACHA / RUN_001</span>
              <span className="console-live">VERIFIED</span>
            </div>
            <div className="timeline-ruler" aria-hidden="true">
              <span>00</span>
              <span>15</span>
              <span>30</span>
              <span>45</span>
              <span>60</span>
            </div>
            <div className="track-row">
              <span>STORY</span>
              <i className="clip clip--wide" />
              <i className="clip clip--short" />
            </div>
            <div className="track-row">
              <span>VOICE</span>
              <i className="waveform" />
            </div>
            <div className="track-row">
              <span>VISUAL</span>
              <i className="clip clip--medium" />
              <i className="clip clip--orange" />
            </div>
            <div className="track-row">
              <span>QC</span>
              <i className="qc-line">
                <b />
                <b />
                <b />
                <b />
                <b />
              </i>
            </div>
            <div className="playhead" aria-hidden="true" />
          </div>
          <p className="hero-caption">
            {content.hero.caption}
            <span>01 / 06</span>
          </p>
        </div>
      </section>

      <section className="proof-strip" aria-label={content.proofLabel}>
        {content.proof.map((item) => (
          <article key={item.label}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </article>
        ))}
      </section>

      <section className="section section--system" id="system">
        <div className="section-heading">
          <p className="section-index">01 / SYSTEM</p>
          <h2>{content.system.title}</h2>
          <p>{content.system.intro}</p>
        </div>
        <div className="feature-grid">
          {content.system.features.map((feature, index) => (
            <article
              className={`feature-card${index === 0 ? " feature-card--lead" : ""}`}
              key={feature.title}
            >
              <p className="card-kicker">{feature.kicker}</p>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <div className="card-diagram" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--workflow" id="workflow">
        <div className="section-heading section-heading--inverse">
          <p className="section-index">02 / WORKFLOW</p>
          <h2>{content.workflow.title}</h2>
          <p>{content.workflow.intro}</p>
        </div>
        <ol className="workflow-list">
          {content.workflow.steps.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
              <b aria-hidden="true">{index < 5 ? "↘" : "✓"}</b>
            </li>
          ))}
        </ol>
        <div className="workflow-result">
          <span className="signal-dot" />
          <p>{content.workflow.resultLabel}</p>
          <strong>{content.workflow.result}</strong>
        </div>
      </section>

      <section className="section section--principles" id="principles">
        <div className="principle-manifesto">
          <p className="section-index">03 / PRINCIPLES</p>
          <blockquote>
            “{content.principles.quoteLead}
            <em>{content.principles.quoteAccent}</em>”
          </blockquote>
          <p>{content.principles.body}</p>
        </div>
        <div className="principle-list">
          {content.principles.items.map((item, index) => (
            <article key={item.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--beauty">
        <div className="beauty-panel">
          <p className="section-index">04 / BEAUTY V2</p>
          <h2>{content.beauty.title}</h2>
          <p>{content.beauty.body}</p>
          <ul>
            {content.beauty.items.map((item) => (
              <li key={item}>
                <span>✓</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="beauty-meter" aria-label={content.beauty.meterLabel}>
          <span className="beauty-meter__label">DEFAULT</span>
          <strong>OFF</strong>
          <div className="beauty-switch" aria-hidden="true">
            <i />
          </div>
          <p>{content.beauty.defaultNote}</p>
        </div>
      </section>

      <section className="section section--install" id="install">
        <div className="install-copy">
          <p className="section-index">05 / START</p>
          <h2>{content.install.title}</h2>
          <p>{content.install.body}</p>
          <div className="agent-tabs" aria-label={content.install.agentLabel}>
            <span>CODEX</span>
            <span>CLAUDE CODE</span>
            <span>LOCAL FIRST</span>
          </div>
        </div>
        <div className="terminal-card">
          <div className="terminal-head">
            <span>~/install-kacha</span>
            <i />
          </div>
          <pre>
            <code>{installCommand}</code>
          </pre>
          <CopyInstall
            command={installCommand}
            copiedLabel={content.install.copied}
            idleLabel={content.install.copy}
          />
          <p>{content.install.note}</p>
        </div>
      </section>

      <footer>
        <div className="footer-brand">
          <LogoMark compact />
          <div>
            <strong>KACHA / 咔嚓</strong>
            <span>{content.footer.tagline}</span>
          </div>
        </div>
        <div className="footer-links">
          <a
            href="https://github.com/colorcross/kacha"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
          <a
            href="https://github.com/colorcross/kacha/blob/main/docs/QUICKSTART.md"
            rel="noreferrer"
            target="_blank"
          >
            {content.footer.docs}
          </a>
          <a
            href="https://github.com/colorcross/kacha/blob/main/LICENSE"
            rel="noreferrer"
            target="_blank"
          >
            MIT
          </a>
        </div>
        <p className="footer-credit">
          {content.footer.credit}
          <span>© 2026</span>
        </p>
      </footer>
    </main>
  );
}
