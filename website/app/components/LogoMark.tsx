type LogoMarkProps = {
  compact?: boolean;
};

const siteBasePath = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? "";

export function LogoMark({ compact = false }: LogoMarkProps) {
  return (
    <span className={`logo-mark${compact ? " logo-mark--compact" : ""}`}>
      {/* The source asset already ships locally; avoid the vinext image shim. */}
      <img
        alt=""
        aria-hidden="true"
        className="logo-mark__image"
        src={`${siteBasePath}/brand/kacha-logo.png`}
      />
    </span>
  );
}
