import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { InteractiveMessageFrame, type InteractiveMessageContext } from './InteractiveMessageFrame.js';

interface MarkdownContentProps {
  content: string;
  interactive?: InteractiveMessageContext;
  inertInteractiveHtml?: readonly string[];
}

export function MarkdownContent({ content, interactive, inertInteractiveHtml = [] }: MarkdownContentProps) {
  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, node: _node, ...props }) => props.href ? (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ) : <span>{children}</span>,
          code: ({ children, className, node: _node, ...props }) => {
            const source = String(children).replace(/\n$/, '');
            const fencedHtml = className?.split(/\s+/).includes('language-html') === true
              && /<(?:html|head|body)\b/i.test(source);
            return interactive !== undefined && fencedHtml && !inertInteractiveHtml.includes(source)
              ? <InteractiveMessageFrame html={source} context={interactive} />
              : <code {...props} className={className}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
