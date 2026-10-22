import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";

/** Markdown with typeset math ($...$ inline, $$...$$ display). Links and raw HTML are not rendered. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("space-y-2 leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:text-white [&_ul]:list-disc [&_ul]:pl-5", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]}
        disallowedElements={["a", "img", "iframe", "script"]}
        unwrapDisallowed
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function TeX({ math, display = false }: { math: string; display?: boolean }) {
  return <Markdown>{display ? `$$${math}$$` : `$${math}$`}</Markdown>;
}
