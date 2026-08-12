interface BrandLockupProps {
  onClick?: () => void;
}

export function BrandLockup({ onClick }: BrandLockupProps) {
  const content = <>
    <span className="brand-mark" aria-hidden="true">研</span>
    <span className="brand-copy">
      <strong>智研AI助手</strong>
      <span>对话式深度研究</span>
    </span>
  </>;

  if (onClick) {
    return <button aria-label="返回首页" className="brand-lockup brand-button" onClick={onClick} type="button">{content}</button>;
  }

  return <div className="brand-lockup">{content}</div>;
}
