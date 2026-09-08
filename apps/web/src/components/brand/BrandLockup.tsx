interface BrandLockupProps {
  /** "header" renders a compact lockup for page headers; "sidebar" fills the sidebar brand slot. */
  variant?: "header" | "sidebar";
  onClick?: () => void;
  /** Accessible label for the clickable variant. */
  label?: string;
}

export function BrandLockup({ variant = "header", onClick, label }: BrandLockupProps) {
  const content = <>
    <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
    <span className="brand-copy">
      <strong>智研<span className="brand-ai">AI</span>顾问</strong>
      <span className="brand-tagline">对话式深度研究</span>
    </span>
  </>;

  const className = variant === "sidebar" ? "brand" : "brand-lockup";

  if (onClick) {
    return (
      <button
        aria-label={label ?? "返回首页"}
        className={variant === "sidebar" ? "brand" : "brand-lockup brand-button"}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
