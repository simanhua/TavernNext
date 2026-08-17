import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
