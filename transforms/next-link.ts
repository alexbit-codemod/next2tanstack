import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextLinkTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  if (
    root.filename().match(/(route|middleware|instrumentation|proxy)\.(ts|js)/)
  ) {
    return null;
  }

  const importNodes = rootNode.findAll({
    rule: {
      kind: "import_statement",
      regex: `from\\s*['"]next/link['"]`,
    },
  });

  if (!importNodes.length) return null;

  const blockers = detectMigrationBlockers(rootNode);
  if (blockers.length) {
    migrationMetric.increment({ bucket: "blocked" });
    console.warn(
      `[next-link] Skipping ${root.filename()} (${blockers.join(", ")})`,
    );
    return null;
  }

  let hasDefaultLinkImport = false;
  for (const node of importNodes) {
    const rewritten = rewriteNextLinkImport(node.text());
    if (!rewritten) continue;
    hasDefaultLinkImport = true;
    edits.push(node.replace(rewritten));
  }

  if (!hasDefaultLinkImport) return null;

  const linkElements = rootNode.findAll({
    rule: {
      any: [
        { pattern: "<Link $$$PROPS />", kind: "jsx_self_closing_element" },
        { pattern: "<Link $$$PROPS>$$$CHILDREN</Link>", kind: "jsx_element" },
      ],
    },
  });

  for (const linkNode of linkElements) {
    const propNodes = linkNode.getMultipleMatches("PROPS");

    const newProps: string[] = [];
    let isExternal = false;
    let externalHref = "";

    for (const propNode of propNodes) {
      const nameNode = propNode.child(0);
      const initializerNode = propNode.child(2);
      if (!nameNode || !initializerNode) continue;

      const propName = nameNode.text();
      const rawValue = initializerNode.text().trim();

      if (propName === "href") {
        // External URL
        if (/^["'`]https?:\/\//.test(rawValue)) {
          isExternal = true;
          externalHref = rawValue;
          continue;
        }

        const expressionValue = unwrapJsxExpression(rawValue);

        // Object href
        if (expressionValue?.startsWith("{") && expressionValue.endsWith("}")) {
          const parsed = parseHrefObject(expressionValue);
          if (parsed.pathname) newProps.push(`to=${parsed.pathname}`);
          if (parsed.search) newProps.push(`search={${parsed.search}}`);
          if (parsed.hash) newProps.push(`hash=${parsed.hash}`);
          continue;
        }

        // Template literal
        if (
          expressionValue?.startsWith("`") &&
          expressionValue.endsWith("`")
        ) {
          const parsed = parseTemplateHref(expressionValue);
          if (parsed.to) {
            newProps.push(`to="${parsed.to}"`);
          } else {
            newProps.push(`to={${expressionValue}}`);
          }

          if (parsed.params.length || parsed.paramMappings.length) {
            const entries = [
              ...parsed.params,
              ...parsed.paramMappings.map((p) => `${p.key}: ${p.value}`),
            ];
            newProps.push(`params={{ ${entries.join(", ")} }}`);
          }
          if (parsed.search) {
            newProps.push(`search={${parsed.search}}`);
          }
          if (parsed.hash) {
            newProps.push(`hash="${parsed.hash}"`);
          }
          continue;
        }

        // Generic expression href fallback
        if (expressionValue) {
          newProps.push(`to={${expressionValue}}`);
          continue;
        }

        // String literal
        const parsed = parseStringHref(rawValue);
        newProps.push(`to="${parsed.path}"`);

        if (parsed.search) {
          newProps.push(`search={${parsed.search}}`);
        }
        if (parsed.hash) {
          newProps.push(`hash="${parsed.hash}"`);
        }
        continue;
      }

      if (propName === "scroll") {
        const val = initializerNode.text().replace(/[{}]/g, "");
        newProps.push(`resetScroll={${val}}`);
        continue;
      }

      if (propName === "prefetch") {
        const val = initializerNode.text().replace(/[{}]/g, "").trim();
        if (val === "true") newProps.push(`preload="intent"`);
        else if (val === "false") newProps.push(`preload={false}`);
        else newProps.push(`preload={${val} ? "intent" : false}`);
        continue;
      }

      if (
        ["as", "shallow", "locale", "legacyBehavior", "passHref"].includes(
          propName,
        )
      ) {
        continue;
      }

      newProps.push(propNode.text());
    }

    const isSelfClosing = linkNode.kind() === "jsx_self_closing_element";
    const propsString = newProps.join(" ");
    const children = linkNode
      .getMultipleMatches("CHILDREN")
      .map((c) => c.text())
      .join("");

    migrationMetric.increment({ bucket: "automated", effort: "low" });
    if (isExternal) {
      edits.push(
        linkNode.replace(
          isSelfClosing
            ? `<a href=${externalHref} ${propsString} />`
            : `<a href=${externalHref} ${propsString}>${children}</a>`,
        ),
      );
      continue;
    }

    edits.push(
      linkNode.replace(
        isSelfClosing
          ? `<Link ${propsString} />`
          : `<Link ${propsString}>${children}</Link>`,
      ),
    );
  }

  return edits;
};

function parseStringHref(str: string): {
  path: string;
  search: string | null;
  hash: string | null;
} {
  const clean = str.replace(/^['"]|['"]$/g, "");
  const [beforeHash, hash] = clean.split("#");
  const [path, query] = beforeHash?.split("?") ?? [];

  return {
    path: path ?? "",
    search: query ? parseSearch(query) : null,
    hash: hash ?? null,
  };
}

function parseTemplateHref(template: string): {
  to: string | null;
  params: string[];
  paramMappings: Array<{ key: string; value: string }>;
  search: string | null;
  hash: string | null;
} {
  const params: string[] = [];
  const paramMappings: Array<{ key: string; value: string }> = [];
  const body = template.slice(1, -1);

  const [beforeHash, hash] = body.split("#");
  const [pathPart, query] = beforeHash?.split("?") ?? [];
  let isConvertible = true;

  const to = pathPart?.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
    const trimmedExpr = String(expr).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmedExpr)) {
      params.push(trimmedExpr);
      return `$${trimmedExpr}`;
    }

    const memberMatch = trimmedExpr.match(
      /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/,
    );
    if (memberMatch?.[2]) {
      const key = memberMatch[2];
      paramMappings.push({ key, value: trimmedExpr });
      return `$${key}`;
    }

    isConvertible = false;
    return `\${${trimmedExpr}}`;
  });

  return {
    to: isConvertible ? (to ?? "") : null,
    params,
    paramMappings,
    search: query ? parseSearch(query) : null,
    hash: hash ?? null,
  };
}

function parseSearch(query: string): string {
  const entries = query.split("&").map((p) => {
    const [k, v] = p.split("=");
    return `${k}: ${isNaN(Number(v)) ? `"${v}"` : Number(v)}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function parseHrefObject(objectStr: string) {
  const pathname = objectStr.match(/pathname:\s*(['"`])(.*?)\1/)?.[2];
  const query = objectStr.match(/query:\s*(\{[^}]*\}|\w+)/)?.[1];
  const hash = objectStr.match(/hash:\s*(['"`])(.*?)\1/)?.[2];

  return {
    pathname: pathname ? `"${pathname}"` : null,
    search: query ?? null,
    hash: hash ? `"${hash}"` : null,
  };
}

function unwrapJsxExpression(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  return trimmed.slice(1, -1).trim();
}

function detectMigrationBlockers(rootNode: { text(): string }): string[] {
  const source = rootNode.text();
  const blockers: string[] = [];

  const importsNextLink = /from\s*['"]next\/link['"]/.test(source);
  const importsUseLinkStatusFromNextLink =
    /import\s+[^;]*\buseLinkStatus\b[^;]*from\s*['"]next\/link['"]/.test(
      source,
    );
  const callsUseLinkStatus = /\buseLinkStatus\s*\(/.test(source);

  if (
    importsUseLinkStatusFromNextLink ||
    (importsNextLink && callsUseLinkStatus)
  ) {
    blockers.push("uses useLinkStatus");
  }

  const hasMdxComponentMapPattern =
    /\buseMDXComponents\s*\(/.test(source) ||
    /from\s*['"]mdx\/types['"]/.test(source) ||
    /\bMDXComponents\b/.test(source);

  if (hasMdxComponentMapPattern) {
    blockers.push("uses MDX component-map pattern");
  }

  return blockers;
}

function rewriteNextLinkImport(importText: string): string | null {
  const normalized = importText.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /^import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*(\{[^}]*\}))?\s+from\s+['"]next\/link['"]\s*;?$/,
  );
  if (!match) return null;

  const defaultImportName = match[1];
  const namedImports = match[2]?.trim();

  if (defaultImportName !== "Link") return null;

  const tanstackImport = `import { Link } from "@tanstack/react-router";`;
  if (!namedImports) return tanstackImport;

  return `${tanstackImport}\nimport ${namedImports} from "next/link";`;
}

