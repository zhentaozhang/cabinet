import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/*
 * Markdown bodies (artifact content, weekly narrative, briefs) sit *inside* a
 * page that already has one `<h1>`. A document written with `# Heading` would
 * otherwise emit a second `<h1>`, which splits the page into two top-level
 * sections and makes the outline read as if the artifact were the page.
 *
 * Shifting every heading down one level keeps the author's own outline intact
 * while guaranteeing the page keeps a single `<h1>`. The `.prose-cabinet` size
 * rules in `globals.css` compensate so nothing gets visually smaller.
 */
const demotedHeadings: Components = {
  h1: ({ children, ...rest }) => <h2 {...rest}>{children}</h2>,
  h2: ({ children, ...rest }) => <h3 {...rest}>{children}</h3>,
  h3: ({ children, ...rest }) => <h4 {...rest}>{children}</h4>,
  h4: ({ children, ...rest }) => <h5 {...rest}>{children}</h5>,
  h5: ({ children, ...rest }) => <h6 {...rest}>{children}</h6>,
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-cabinet max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={demotedHeadings}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
