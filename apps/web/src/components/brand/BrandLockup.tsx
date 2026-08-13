interface BrandLockupProps {
  onClick?: () => void;
}

export function BrandLockup({ onClick }: BrandLockupProps) {
  const content = <>
    <img alt="" className="brand-mark" src="/brand-logo.png" />
    <span className="brand-copy">
      <strong>智研<span className="brand-ai">AI</span>助手</strong>
      <span>对话式深度研究</span>
    </span>
  </>;

  if (onClick) {
    return <button aria-label="返回首页" className="brand-lockup brand-button" onClick={onClick} type="button">{content}</button>;
  }

  return <div className="brand-lockup">{content}</div>;
}
