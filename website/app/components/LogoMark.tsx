type LogoMarkProps = {
  compact?: boolean;
};

export function LogoMark({ compact = false }: LogoMarkProps) {
  return (
    <span className={`logo-mark${compact ? " logo-mark--compact" : ""}`}>
      {/* The source asset already ships locally; avoid the vinext image shim. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden="true"
        className="logo-mark__image"
        src="/brand/kacha-logo.png"
      />
    </span>
  );
}
