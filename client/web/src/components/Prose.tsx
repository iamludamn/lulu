import { memo, useRef, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./Copy";

const REMARK_PLUGINS = [remarkGfm];

function CodeBlock({ node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={ref} {...props} />
      <CopyButton className="code-copy" text={() => ref.current?.textContent ?? ""} />
    </div>
  );
}

function Link({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}

function Table({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="table-scroll">
      <table {...props} />
    </div>
  );
}

const COMPONENTS: Components = { pre: CodeBlock, a: Link, table: Table };

export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {text}
    </Markdown>
  );
});
