import { useEffect, useState } from "react";

export function CopyButton({ text, label = "复制", className }: { text: () => string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard.writeText(text()).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? "已复制" : label}
    </button>
  );
}
