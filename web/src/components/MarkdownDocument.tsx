import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type ClipboardEventHandler,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";
import type { UponSanitizeAttributeHook, UponSanitizeElementHook } from "dompurify";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { decodeString } from "micromark-util-decode-string";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { resolvePersistedAttachmentUrl } from "../api";
import { useTaskboardI18n } from "../i18n";

interface MarkdownAstNode {
  type: string;
  value?: string;
  children?: MarkdownAstNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

const RAW_COMMENT = /<!--[\s\S]*?-->/g;
const EXTERNAL_CSS_REFERENCE = /@import|url\s*\(\s*(?!(?:['"]\s*)?#)/i;
const MERMAID_FRONTMATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;
const MERMAID_EXTERNAL_RESOURCE = /^\s*(?:(?:Person(?:_Ext)?|System(?:Db|Queue)?(?:_Ext)?)\s*\((?:(?:"[^"\r\n]*"|[^,\r\n]*)\s*,){3}|(?:(?:Container|Component)(?:Db|Queue)?(?:_Ext)?|Deployment_Node|Node(?:_[LR])?)\s*\((?:(?:"[^"\r\n]*"|[^,\r\n]*)\s*,){4}|(?:Rel(?:_(?:Up|Down|Left|Right|Back|[UDLR]))?|BiRel)\s*\((?:(?:"[^"\r\n]*"|[^,\r\n]*)\s*,){5}|RelIndex\s*\((?:(?:"[^"\r\n]*"|[^,\r\n]*)\s*,){6}|UpdateElementStyle\s*\((?:(?:"[^"\r\n]*"|[^,\r\n]*)\s*,){6})\s*(?:\$sprite\s*=\s*)?["']?\s*(?:https?:)?\/\//im;
const MERMAID_SEQUENCE_PROPERTIES = /(?:^|[;\r\n])\s*properties\s+[^:\r\n;]+\s*:[^\S\r\n]*/gim;

interface EncodedCommentMarker {
  kind: "open" | "close";
  node: MarkdownAstNode;
  sourceOffset: number;
  sourceEndOffset: number;
  valueOffset: number;
  valueEndOffset: number;
}

interface EncodedCommentRange {
  open: EncodedCommentMarker;
  close: EncodedCommentMarker;
}

function mermaidObjectEnd(source: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hasFlowchartImageResource(source: string) {
  const flowSource = source.replace(/^\s*%%(?!\{)[^\n]+\n?/gm, "").trimStart();
  const edgeTextRules = [
    { start: /^\s*[xo<]?--\s*/, end: /^\s*[xo<]?--+[-xo>]\s*/ },
    { start: /^\s*[xo<]?==\s*/, end: /^\s*[xo<]?==+[=xo>]\s*/ },
    { start: /^\s*[xo<]?-\.\s*/, end: /^\s*[xo<]?-?\.+-[xo>]?\s*/ },
  ];
  let inString = false;
  let edgeTextEnd: RegExp | null = null;
  for (let index = 0; index < flowSource.length; index += 1) {
    const remainingSource = flowSource.slice(index);
    if (flowSource[index] === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (edgeTextEnd) {
      const edgeEnd = remainingSource.match(edgeTextEnd);
      if (edgeEnd) {
        edgeTextEnd = null;
        index += edgeEnd[0].length - 1;
      }
      continue;
    }
    const fullLink = edgeTextRules.map(({ end }) => remainingSource.match(end)).find(Boolean);
    if (fullLink) {
      index += fullLink[0].length - 1;
      continue;
    }
    const edgeText = edgeTextRules.map(({ start, end }) => ({
      end,
      match: remainingSource.match(start),
    })).find(({ match }) => match);
    if (edgeText?.match) {
      edgeTextEnd = edgeText.end;
      index += edgeText.match[0].length - 1;
      continue;
    }
    if (!flowSource.startsWith("@{", index)) continue;
    const objectStart = index + 1;
    const objectEnd = mermaidObjectEnd(flowSource, objectStart);
    if (objectEnd < 0) continue;
    const metadataSource = flowSource.slice(objectStart + 1, objectEnd);
    const yamlSource = metadataSource.includes("\n")
      ? `${metadataSource}\n`
      : `{\n${metadataSource}\n}`;
    try {
      const metadata = loadYaml(yamlSource, { schema: JSON_SCHEMA });
      if (
        metadata !== null
        && typeof metadata === "object"
        && !Array.isArray(metadata)
        && (metadata as Record<string, unknown>).img
      ) return true;
    } catch {
      continue;
    }
    index = objectEnd;
  }
  return false;
}

function hasExternalThemeCss(config: unknown) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return false;
  const themeCss = (config as Record<string, unknown>).themeCSS;
  return typeof themeCss === "string" && EXTERNAL_CSS_REFERENCE.test(themeCss);
}

function hasExternalMermaidCss(source: string) {
  const frontmatter = source.match(MERMAID_FRONTMATTER);
  if (frontmatter) {
    const indent = frontmatter[1];
    const yamlSource = indent
      ? frontmatter[2].split("\n").map((line) => (
        line.startsWith(indent) ? line.slice(indent.length) : line
      )).join("\n")
      : frontmatter[2];
    try {
      const metadata = loadYaml(yamlSource, { schema: JSON_SCHEMA });
      if (
        metadata !== null
        && typeof metadata === "object"
        && !Array.isArray(metadata)
        && hasExternalThemeCss((metadata as Record<string, unknown>).config)
      ) return true;
    } catch {
      // Mermaid reports malformed frontmatter through the existing render fallback.
    }
  }

  for (const directive of source.matchAll(/%%\{\s*(?:init|initialize)\b\s*:?\s*([\s\S]*?)\}%%/gi)) {
    try {
      if (hasExternalThemeCss(JSON.parse(directive[1].trim().replace(/'/g, '"')))) return true;
    } catch {
      continue;
    }
  }

  const statements: string[] = [];
  let start = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === ";" || character === "\r" || character === "\n") {
      statements.push(source.slice(start, index));
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      start = index + 1;
    }
  }
  statements.push(source.slice(start));

  return statements.some((statement) => (
    /^\s*(?:style\s+\S+|classDef\s+\S+|linkStyle\s+\S+|rect\b|UpdateElementStyle\s*\(|UpdateRelStyle\s*\()/i.test(statement)
    && EXTERNAL_CSS_REFERENCE.test(statement)
  ));
}

function hasExternalMermaidResource(source: string) {
  if (MERMAID_EXTERNAL_RESOURCE.test(source) || hasFlowchartImageResource(source)) return true;
  for (const match of source.matchAll(MERMAID_SEQUENCE_PROPERTIES)) {
    let objectStart = match.index + match[0].length;
    const wrapPrefix = source.slice(objectStart).match(/^:?(?:no)?wrap:[^\S\r\n]*/);
    if (wrapPrefix) objectStart += wrapPrefix[0].length;
    if (source[objectStart] !== "{") continue;
    const objectEnd = mermaidObjectEnd(source, objectStart);
    if (objectEnd < 0) continue;
    try {
      const properties = JSON.parse(source.slice(objectStart, objectEnd + 1)) as Record<string, unknown>;
      const icon = properties.icon;
      if (typeof icon === "string") {
        const iconSource = icon.trim();
        if (iconSource !== "" && !iconSource.startsWith("@")) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function isLocalSvgReference(element: Element, reference: string) {
  if (!reference.startsWith("#") || reference.length === 1) return false;
  const svg = element.localName === "svg" ? element as SVGSVGElement : (element as SVGElement).ownerSVGElement;
  if (!svg) return false;
  const targetId = reference.slice(1);
  return svg.id === targetId || [...svg.querySelectorAll<SVGElement>("[id]")].some((target) => target.id === targetId);
}

export function remarkStripMarkdownComments() {
  return (tree: MarkdownAstNode, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const markers: EncodedCommentMarker[] = [];

    const collectMarkers = (node: MarkdownAstNode) => {
      if (node.type === "text" && node.value && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
        const sourceStart = node.position.start.offset;
        const sourceValue = source.slice(sourceStart, node.position.end.offset);
        const sourceOpenMarkers = [...sourceValue.matchAll(/&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});!--/gi)].filter((match) => {
          let backslashes = 0;
          for (let index = (match.index ?? 0) - 1; index >= 0 && sourceValue[index] === "\\"; index -= 1) {
            backslashes += 1;
          }
          return backslashes % 2 === 0;
        });
        sourceOpenMarkers.forEach((match) => {
          if (decodeString(match[0]) !== "<!--") return;
          const valueOffset = decodeString(sourceValue.slice(0, match.index ?? 0)).length;
          if (!node.value!.startsWith("<!--", valueOffset)) return;
          markers.push({
            kind: "open",
            node,
            sourceOffset: sourceStart + (match.index ?? 0),
            sourceEndOffset: sourceStart + (match.index ?? 0) + match[0].length,
            valueOffset,
            valueEndOffset: valueOffset + "<!--".length,
          });
        });

        const sourceCloseMarkers = [...sourceValue.matchAll(/--&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi)];
        sourceCloseMarkers.forEach((match) => {
          if (decodeString(match[0]) !== "-->") return;
          const valueOffset = decodeString(sourceValue.slice(0, match.index ?? 0)).length;
          if (!node.value!.startsWith("-->", valueOffset)) return;
          markers.push({
            kind: "close",
            node,
            sourceOffset: sourceStart + (match.index ?? 0),
            sourceEndOffset: sourceStart + (match.index ?? 0) + match[0].length,
            valueOffset,
            valueEndOffset: valueOffset + "-->".length,
          });
        });
      }
      node.children?.forEach(collectMarkers);
    };
    collectMarkers(tree);

    const ranges: EncodedCommentRange[] = [];
    let open: EncodedCommentMarker | null = null;
    markers.sort((left, right) => left.sourceOffset - right.sourceOffset).forEach((marker) => {
      if (marker.kind === "open") {
        if (!open) open = marker;
      } else if (open) {
        ranges.push({ open, close: marker });
        open = null;
      }
    });

    const fullyInsideRange = (node: MarkdownAstNode) => (
      node.position?.start.offset !== undefined
      && node.position.end.offset !== undefined
      && ranges.some((range) => (
        range.open.sourceOffset <= node.position!.start.offset!
        && node.position!.end.offset! <= range.close.sourceEndOffset
      ))
    );

    const visit = (node: MarkdownAstNode, root = false): boolean => {
      if (!root && fullyInsideRange(node)) return false;
      if (node.type === "html" && node.value) {
        node.value = node.value.replace(RAW_COMMENT, "");
        return node.value.trim().length > 0;
      }
      if (node.type === "text" && node.value && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
        const removals = ranges.flatMap((range) => {
          if (node.position!.end.offset! <= range.open.sourceOffset || range.close.sourceEndOffset <= node.position!.start.offset!) {
            return [];
          }
          return [{
            start: range.open.node === node ? range.open.valueOffset : 0,
            end: range.close.node === node ? range.close.valueEndOffset : node.value!.length,
          }];
        }).sort((left, right) => right.start - left.start);
        for (const removal of removals) {
          node.value = node.value.slice(0, removal.start) + node.value.slice(removal.end);
        }
        return node.value.length > 0;
      }
      if (node.children) {
        node.children = node.children.filter((child) => visit(child));
        if (!root && node.children.length === 0) return false;
      }
      return true;
    };
    visit(tree, true);
    const children = tree.children;
    if (!children || children.length < 2) return;
    const nextChildren: MarkdownAstNode[] = [];

    children.forEach((child, index) => {
      const previous = children[index - 1];
      const previousEnd = previous?.position?.end.offset;
      const childStart = child.position?.start.offset;
      if (previousEnd !== undefined && childStart !== undefined) {
        const gap = source.slice(previousEnd, childStart);
        if (/^[\t \r\n]*$/.test(gap)) {
          const extraBlankLines = Math.max(0, (gap.match(/\r\n|\r|\n/g)?.length ?? 0) - 2);
          for (let blankLine = 0; blankLine < extraBlankLines; blankLine += 1) {
            nextChildren.push({
              type: "paragraph",
              children: [],
              data: {
                hName: "div",
                hProperties: {
                  className: ["markdown-blank-line"],
                  "aria-hidden": "true",
                },
              },
            });
          }
        }
      }
      nextChildren.push(child);
    });
    tree.children = nextChildren;
  };
}

function codeBlockLanguage(children: ReactNode): { language: string | null; source: string } {
  const code = Children.toArray(children).find(
    (child): child is ReactElement<{ className?: string; children?: ReactNode }> => (
      isValidElement(child) && child.type === "code"
    ),
  );
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() ?? null;
  return { language, source: Children.toArray(code?.props.children).join("") };
}

function MermaidFallback({ source, error }: { source: string; error?: boolean }) {
  const { text } = useTaskboardI18n();
  return (
    <div className="markdown-mermaid-fallback" role={error ? "alert" : undefined}>
      {error && <p>{text(
        "无法渲染 Mermaid 图，下面显示图表源码。",
        "Unable to render Mermaid diagram. Showing its source instead.",
      )}</p>}
      <details open={error}>
        <summary>{text("Mermaid 源码", "Mermaid source")}</summary>
        <pre><code className="language-mermaid">{source}</code></pre>
      </details>
    </div>
  );
}

export function MermaidDiagram({ source }: { source: string }) {
  const { text } = useTaskboardI18n();
  const reactId = useId();
  const renderId = `taskboard-mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [theme, setTheme] = useState<"light" | "dark">(() => (
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light"
  ));
  const [diagram, setDiagram] = useState<(
    { source: string; theme: "light" | "dark" } & ({ svg: string } | { error: true })
  ) | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDiagram(null);
    if (hasExternalMermaidResource(source) || hasExternalMermaidCss(source)) {
      setDiagram({ source, theme, error: true });
      return undefined;
    }
    void Promise.all([import("mermaid"), import("dompurify")])
      .then(async ([mermaidModule, purifierModule]) => {
        const mermaid = mermaidModule.default;
        const purifier = purifierModule.default;
        const preserveLocalUse: UponSanitizeElementHook = (node, data) => {
          if (!(node instanceof Element) || node.localName !== "use") return;
          const reference = node.getAttribute("href") ?? node.getAttribute("xlink:href");
          if (reference && isLocalSvgReference(node, reference)) data.allowedTags.use = true;
        };
        const filterSvgReferences: UponSanitizeAttributeHook = (node, data) => {
          if (data.attrName !== "href" && data.attrName !== "xlink:href") return;
          if (isLocalSvgReference(node, data.attrValue)) {
            data.forceKeepAttr = true;
          } else {
            data.keepAttr = false;
          }
        };
        purifier.addHook("uponSanitizeElement", preserveLocalUse);
        purifier.addHook("uponSanitizeAttribute", filterSvgReferences);
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: theme === "dark" ? "dark" : "default",
            htmlLabels: false,
            secure: ["htmlLabels"],
          });
          const { svg } = await mermaid.render(renderId, source);
          const sanitizedSvg = purifier.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ["foreignObject", "image", "script"],
            FORBID_ATTR: ["href", "xlink:href"],
          });
          const svgRoot = document.createElement("template");
          svgRoot.innerHTML = sanitizedSvg;
          if (svgRoot.content.children.length !== 1 || svgRoot.content.firstElementChild?.localName !== "svg") {
            throw new Error("Mermaid did not produce a usable SVG document.");
          }
          svgRoot.content.querySelectorAll("style").forEach((element) => {
            if (EXTERNAL_CSS_REFERENCE.test(element.textContent ?? "")) element.remove();
          });
          svgRoot.content.querySelectorAll<SVGElement>("[style]").forEach((element) => {
            if (EXTERNAL_CSS_REFERENCE.test(element.getAttribute("style") ?? "")) {
              element.removeAttribute("style");
            }
          });
          if (!cancelled) setDiagram({ source, theme, svg: svgRoot.innerHTML });
        } finally {
          purifier.removeHook("uponSanitizeElement", preserveLocalUse);
          purifier.removeHook("uponSanitizeAttribute", filterSvgReferences);
        }
      })
      .catch(() => {
        if (!cancelled) setDiagram({ source, theme, error: true });
      });
    return () => { cancelled = true; };
  }, [renderId, source, theme]);

  const currentDiagram = diagram?.source === source && diagram.theme === theme ? diagram : null;
  if (!currentDiagram) {
    return <div className="markdown-mermaid" aria-busy="true"><MermaidFallback source={source} /></div>;
  }
  if ("error" in currentDiagram) {
    return <div className="markdown-mermaid"><MermaidFallback source={source} error /></div>;
  }
  return (
    <div
      className="markdown-mermaid"
      role="img"
      aria-label={text("Mermaid 图", "Mermaid diagram")}
      dangerouslySetInnerHTML={{ __html: currentDiagram.svg }}
    />
  );
}

function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const { language, source } = codeBlockLanguage(children);
  if (language === "mermaid") return <MermaidDiagram source={source} />;
  return <pre {...props}>{children}</pre>;
}

export function MarkdownDocument({
  value,
  onCopy,
  onImageClick,
  onLinkClick,
  renderLink,
}: {
  value: string;
  onCopy?: ClipboardEventHandler<HTMLDivElement>;
  onImageClick?: (event: MouseEvent<HTMLImageElement>) => void;
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>, href?: string) => void;
  renderLink?: (href: string | undefined, children: ReactNode) => ReactNode | null;
}) {
  return (
    <div className="issue-description-document" onCopy={onCopy}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkStripMarkdownComments, remarkBreaks]}
        urlTransform={(url) => defaultUrlTransform(resolvePersistedAttachmentUrl(url))}
        components={{
          a: ({ node, href, children, className, ...props }) => {
            const renderedLink = renderLink?.(href, children);
            const isRenderedLink = renderedLink !== null && renderedLink !== undefined;
            const start = node?.position?.start.offset;
            const end = node?.position?.end.offset;
            const markdown = typeof start === "number" && typeof end === "number"
              ? value.slice(start, end)
              : undefined;
            const isComposerReference = Boolean(
              markdown && /^\[[\s\S]*\]\(taskboard:\/\/composer-reference\/[^)]+\)$/.test(markdown),
            );
            if (isValidElement(renderedLink) && renderedLink.type === "video") {
              return renderedLink;
            }
            return (
              <a
                {...props}
                className={[className, isRenderedLink ? "issue-reference-link" : ""].filter(Boolean).join(" ") || undefined}
                data-taskboard-inline-media-markdown={isRenderedLink || isComposerReference ? markdown : undefined}
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => onLinkClick?.(event, href)}
              >
                {isRenderedLink ? renderedLink : children}
              </a>
            );
          },
          img: ({ node, ...props }) => {
            const start = node?.position?.start.offset;
            const end = node?.position?.end.offset;
            const markdown = typeof start === "number" && typeof end === "number"
              ? value.slice(start, end)
              : undefined;
            const selfContainedMarkdown = markdown
              && /^!\[(?:\\.|[^\]])*\]\(/.test(markdown)
              ? markdown
              : undefined;
            return (
              <img
                {...props}
                className={[props.className, onImageClick ? "is-previewable" : ""].filter(Boolean).join(" ") || undefined}
                data-taskboard-inline-media-markdown={selfContainedMarkdown}
                onClick={onImageClick}
              />
            );
          },
          pre: MarkdownPre,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
