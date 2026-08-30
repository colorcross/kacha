import { CopyInstall } from "./CopyInstall";
import { LogoMark } from "./LogoMark";
import { ScrollLink } from "./ScrollLink";
import type { SiteContent } from "../site-content";

const installCommand =
  "curl -fsSL https://raw.githubusercontent.com/colorcross/kacha/main/scripts/install.sh | bash -s -- --agent both --channel canary";
const siteBasePath = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? "";
const contactEmail = "dodofun@126.com";
const channelAssets = {
  wechat: "wechat-channels.jpg",
  douyin: "douyin.png",
  xiaohongshu: "xiaohongshu.jpg",
} as const;

function OutcomeVisual({
  index,
  beforeLabel,
  afterLabel,
  label,
}: {
  index: number;
  beforeLabel: string;
  afterLabel: string;
  label: string;
}) {
  return (
    <div
      aria-label={`${beforeLabel} / ${afterLabel}: ${label}`}
      className={`outcome-demo outcome-demo--${index + 1}`}
      role="img"
    >
      <div className="outcome-demo__labels">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      <div className="outcome-demo__stage" aria-hidden="true">
        {index === 0 ? (
          <>
            <div className="demo-transcript demo-transcript--before">
              <i />
              <i />
              <i />
              <b />
            </div>
            <span className="demo-arrow">→</span>
            <div className="demo-transcript demo-transcript--after">
              <i />
              <i />
              <i />
              <b />
            </div>
          </>
        ) : null}
        {index === 1 ? (
          <>
            <div className="demo-audio demo-audio--before">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <span className="demo-arrow">→</span>
            <div className="demo-audio demo-audio--after">
              <span />
              <span />
              <span />
              <span />
              <span />
              <b />
            </div>
          </>
        ) : null}
        {index === 2 ? (
          <>
            <div className="demo-frame demo-frame--before">
              <span />
              <i />
              <b />
            </div>
            <span className="demo-arrow">→</span>
            <div className="demo-frame demo-frame--after">
              <span />
              <i />
              <b />
            </div>
          </>
        ) : null}
        {index === 3 ? (
          <>
            <div className="demo-layers demo-layers--before">
              <span />
              <span />
              <span />
              <span />
            </div>
            <span className="demo-arrow">→</span>
            <div className="demo-layers demo-layers--after">
              <span />
              <span />
              <span />
              <span />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function StyleGrammarVisual({
  id,
  label,
}: {
  id: "light" | "spatial" | "comic" | "pixel" | "dark";
  label: string;
}) {
  return (
    <div
      aria-label={label}
      className={`grammar-visual grammar-visual--${id}`}
      role="img"
    >
      {id === "light" ? (
        <>
          <span className="grammar-subject"><i /><b /></span>
          <span className="grammar-note grammar-note--one"><i />01</span>
          <span className="grammar-note grammar-note--two"><i />02</span>
          <span className="grammar-reading-line" />
        </>
      ) : null}
      {id === "spatial" ? (
        <>
          <span className="grammar-depth-plane grammar-depth-plane--back" />
          <span className="grammar-depth-plane grammar-depth-plane--front" />
          <svg aria-hidden="true" viewBox="0 0 560 240">
            <path d="M34 190 C148 218 146 74 278 116 S422 74 526 34" />
          </svg>
          <span className="grammar-node grammar-node--one" />
          <span className="grammar-node grammar-node--two" />
          <span className="grammar-node grammar-node--three" />
        </>
      ) : null}
      {id === "comic" ? (
        <>
          <span className="grammar-panel grammar-panel--setup"><i>01</i></span>
          <span className="grammar-panel grammar-panel--reaction"><i>…</i></span>
          <span className="grammar-panel grammar-panel--punch"><i>!</i></span>
          <span className="grammar-comic-slash" />
        </>
      ) : null}
      {id === "pixel" ? (
        <>
          <span className="grammar-pixel-grid" />
          <span className="grammar-register grammar-register--input"><i />INPUT</span>
          <span className="grammar-register grammar-register--process"><i />RULE</span>
          <span className="grammar-register grammar-register--result"><i />PASS</span>
          <span className="grammar-cursor" />
        </>
      ) : null}
      {id === "dark" ? (
        <>
          <span className="grammar-dark-aperture" />
          <span className="grammar-dark-bracket grammar-dark-bracket--one" />
          <span className="grammar-dark-bracket grammar-dark-bracket--two" />
          <span className="grammar-dark-trace" />
          <span className="grammar-dark-evidence">EVIDENCE 01</span>
          <span className="grammar-dark-verdict"><i />VERIFIED</span>
        </>
      ) : null}
    </div>
  );
}

export function SiteShell({
  content,
  locale,
}: {
  content: SiteContent;
  locale: "zh" | "en";
}) {
  return (
    <div className="site-root" lang={locale === "zh" ? "zh-CN" : "en"}>
      <a className="skip-link" href="#main-content">
        {content.skipToContent}
      </a>
      <header className="site-header">
        <ScrollLink
          ariaLabel={content.brandHome}
          className="brand-lockup"
          targetId="top"
        >
          <LogoMark compact />
          <span className="brand-wordmark">KACHA</span>
          <span className="brand-cn">咔嚓</span>
        </ScrollLink>
        <nav aria-label={content.navLabel}>
          <ScrollLink targetId="problems">{content.nav.problems}</ScrollLink>
          <ScrollLink targetId="outcomes">{content.nav.outcomes}</ScrollLink>
          <ScrollLink targetId="styles">{content.nav.styles}</ScrollLink>
          <ScrollLink targetId="workflow">{content.nav.workflow}</ScrollLink>
          <ScrollLink targetId="install">{content.nav.install}</ScrollLink>
          <ScrollLink targetId="contact">{content.nav.contact}</ScrollLink>
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

      <main id="main-content" tabIndex={-1}>
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
            <ScrollLink
              className="button button--primary"
              targetId="problems"
            >
              {content.hero.primaryCta}
              <span aria-hidden="true">↓</span>
            </ScrollLink>
            <ScrollLink className="button button--quiet" targetId="install">
              {content.hero.secondaryCta}
              <span aria-hidden="true">↘</span>
            </ScrollLink>
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

        <div
          aria-label={content.hero.visualLabel}
          className="hero-visual"
          role="img"
        >
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
            <div className="console-status" aria-hidden="true">
              <span><i />SOURCE / RAW</span>
              <b>→</b>
              <span><i />OUTPUT / CANDIDATE</span>
            </div>
            <div className="playhead" aria-hidden="true" />
          </div>
          <p className="hero-caption">
            {content.hero.caption}
            <span>01 / 04</span>
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

      <section className="section section--problems" id="problems">
        <div className="section-heading">
          <p className="section-index">01 / PROBLEMS</p>
          <h2>{content.problems.title}</h2>
          <p>{content.problems.intro}</p>
        </div>
        <div className="problem-grid">
          {content.problems.items.map((item) => (
            <article className="problem-card" key={item.number}>
              <span>{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--outcomes" id="outcomes">
        <div className="section-heading section-heading--inverse">
          <p className="section-index">02 / RESULTS</p>
          <h2>{content.outcomes.title}</h2>
          <p>{content.outcomes.intro}</p>
        </div>
        <div className="outcome-grid">
          {content.outcomes.items.map((item, index) => (
            <article className="outcome-card" key={item.title}>
              <OutcomeVisual
                afterLabel={content.outcomes.afterLabel}
                beforeLabel={content.outcomes.beforeLabel}
                index={index}
                label={item.title}
              />
              <p className="card-kicker">{item.kicker}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
              <strong>{item.proof}</strong>
            </article>
          ))}
        </div>
        <p className="outcome-note">{content.outcomes.demoNote}</p>
      </section>

      <section className="section section--styles" id="styles">
        <div className="section-heading">
          <p className="section-index">03 / EDITING GRAMMARS</p>
          <h2>{content.styles.title}</h2>
          <p>{content.styles.intro}</p>
        </div>
        <div className="grammar-grid">
          {content.styles.items.map((style) => (
            <article
              className={`grammar-card grammar-card--${style.id}`}
              key={style.id}
            >
              <StyleGrammarVisual id={style.id} label={style.title} />
              <div className="grammar-card__copy">
                <p className="card-kicker">{style.kicker}</p>
                <h3>{style.title}</h3>
                <p>{style.body}</p>
                <ol aria-label={style.sequence}>
                  {style.sequence.split(" → ").map((step, index) => (
                    <li key={step}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      {step}
                    </li>
                  ))}
                </ol>
                <strong>{style.sound}</strong>
              </div>
            </article>
          ))}
        </div>
        <div className="grammar-audit">
          <span>{content.styles.auditLabel}</span>
          <strong>{content.styles.auditValue}</strong>
        </div>
      </section>

      <section className="section section--system" id="system">
        <div className="section-heading">
          <p className="section-index">04 / CAPABILITIES</p>
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
          <p className="section-index">05 / WORKFLOW</p>
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
                <small>{step.stages}</small>
              </div>
              <b>{step.state}</b>
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
          <p className="section-index">06 / WHY KACHA</p>
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

      <section className="section section--fit">
        <div className="section-heading">
          <p className="section-index">07 / FIT</p>
          <h2>{content.fit.title}</h2>
          <p>{content.fit.intro}</p>
        </div>
        <div className="fit-grid">
          {content.fit.items.map((item, index) => (
            <article key={item.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section--faq">
        <div className="section-heading">
          <p className="section-index">08 / FAQ</p>
          <h2>{content.faq.title}</h2>
          <p>{content.faq.intro}</p>
        </div>
        <div className="faq-list">
          {content.faq.items.map((item, index) => (
            <details key={item.question}>
              <summary>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item.question}
                <b aria-hidden="true">＋</b>
              </summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="section section--install" id="install">
        <div className="install-copy">
          <p className="section-index">09 / START</p>
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
            failedLabel={content.install.copyFailed}
            idleLabel={content.install.copy}
          />
          <p>{content.install.note}</p>
        </div>
      </section>

      <section className="section section--contact" id="contact">
        <div className="contact-copy">
          <p className="section-index">10 / CONTACT</p>
          <h2>{content.contact.title}</h2>
          <p>{content.contact.body}</p>
          <span>{content.contact.emailLabel}</span>
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </div>
        <div className="contact-channels">
          <p>{content.contact.channelsLabel}</p>
          <div className="qr-grid">
            {content.contact.channels.map((channel) => (
              <article key={channel.id}>
                <div className="qr-frame">
                  <img
                    alt={`${channel.name} ${channel.note} QR code`}
                    height="720"
                    loading="lazy"
                    src={`${siteBasePath}/social/${channelAssets[channel.id]}`}
                    width="720"
                  />
                </div>
                <strong>{channel.name}</strong>
                <span>{channel.note}</span>
              </article>
            ))}
          </div>
        </div>
      </section>
      </main>

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
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </div>
        <p className="footer-credit">
          {content.footer.credit}
          <span>© 2026</span>
        </p>
      </footer>
    </div>
  );
}
