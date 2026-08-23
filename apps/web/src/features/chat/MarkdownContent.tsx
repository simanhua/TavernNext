import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { InteractiveMessageFrame, type InteractiveMessageContext } from './InteractiveMessageFrame.js';

interface MarkdownContentProps {
  content: string;
  interactive?: InteractiveMessageContext;
  inertInteractiveHtml?: readonly string[];
}

interface MarkdownNode {
  type?: string;
  value?: string;
  lang?: string | null;
  children?: MarkdownNode[];
}

export function interactiveHtmlFences(content: string): string[] {
  const root = unified().use(remarkParse).parse(normalizeInteractiveHtmlFences(content)) as MarkdownNode;
  const values: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === 'code' && (node.lang == null || node.lang.toLowerCase() === 'html')
      && typeof node.value === 'string' && /<(?:html|head|body)\b/i.test(node.value)) {
      values.push(node.value);
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return values;
}

export function normalizeInteractiveHtmlFences(content: string): string {
  return content.replace(
    /([^\r\n])(```(?:html)?\r?\n(?=\s*<(?:html|head|body)\b))/gi,
    '$1\n\n$2',
  );
}

export function MarkdownContent({ content, interactive, inertInteractiveHtml = [] }: MarkdownContentProps) {
  const projectedContent = interactive === undefined ? content : normalizeInteractiveHtmlFences(content);
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
          code: ({ children, className, node, ...props }) => {
            const source = String(children).replace(/\n$/, '');
            const block = node?.position?.start.line !== node?.position?.end.line;
            const languageHtml = className?.split(/\s+/).includes('language-html') === true;
            const fencedHtml = block && (languageHtml || className === undefined)
              && /<(?:html|head|body)\b/i.test(source);
            return interactive !== undefined && fencedHtml && !inertInteractiveHtml.includes(source)
              ? <InteractiveMessageFrame html={source} context={interactive} />
              : <code {...props} className={className}>{children}</code>;
          },
        }}
      >
        {projectedContent}
      </ReactMarkdown>
    </div>
  );
}
