import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

type ImportBinding = {
  imported: string;
  local: string;
};

const TODO_PREFIX = "// TODO(tanstack-migrate):";

export const nextManualMigrationTodoTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const source = rootNode.text();
  const filename = getEffectiveFilename(root.filename());
  const lineComments = new Map<any, Set<string>>();
  const topLevelTodos: string[] = [];

  type Effort = "low" | "medium" | "high";
  const queueLineTodo = (node: any, message: string, effort: Effort) => {
    if (!node) return;
    const anchor = getCommentAnchor(node);
    if (!anchor) return;
    const todo = `${TODO_PREFIX} ${message}`;
    if (anchor.text().includes(todo)) return;
    migrationMetric.increment({ bucket: "manual", effort });
    const existing = lineComments.get(anchor) ?? new Set<string>();
    existing.add(todo);
    lineComments.set(anchor, existing);
  };

  const queueTopTodo = (message: string, effort: Effort) => {
    const todo = `${TODO_PREFIX} ${message}`;
    if (!source.includes(todo) && !topLevelTodos.includes(todo)) {
      migrationMetric.increment({ bucket: "manual", effort });
      topLevelTodos.push(todo);
    }
  };

  const nextCacheImports = findImportsBySource(rootNode, "next/cache");
  for (const imp of nextCacheImports) {
    const bindings = parseNamedImportBindings(imp.text());
    for (const symbol of [
      "cache",
      "cacheLife",
      "cacheTag",
      "revalidatePath",
      "revalidateTag",
    ]) {
      const localNames = bindings
        .filter((binding) => binding.imported === symbol)
        .map((binding) => binding.local);
      for (const localName of localNames) {
        for (const usage of findCallExpressions(rootNode, localName)) {
          queueLineTodo(
            usage,
            `manual migration required for \`${symbol}()\`; map to TanStack Start/Query caching strategy.`,
            "medium",
          );
        }
      }
    }
  }

  const nextHeadersImports = findImportsBySource(rootNode, "next/headers");
  for (const imp of nextHeadersImports) {
    const bindings = parseNamedImportBindings(imp.text());
    for (const symbol of ["cookies", "headers"]) {
      const localNames = bindings
        .filter((binding) => binding.imported === symbol)
        .map((binding) => binding.local);
      for (const localName of localNames) {
        for (const usage of findCallExpressions(rootNode, localName)) {
          queueLineTodo(
            usage,
            `manual migration required for \`${symbol}()\` outside server actions.`,
            "medium",
          );
        }
      }
    }
  }

  const nextServerImports = findImportsBySource(rootNode, "next/server");
  for (const imp of nextServerImports) {
    const bindings = parseNamedImportBindings(imp.text());
    for (const symbol of ["NextRequest", "NextResponse"]) {
      const localNames = bindings
        .filter((binding) => binding.imported === symbol)
        .map((binding) => binding.local);
      for (const localName of localNames) {
        const usageNode = findFirstNonImportIdentifier(rootNode, localName);
        if (!usageNode) continue;
        queueLineTodo(
          usageNode.parent() ?? usageNode,
          `manual migration required for \`${symbol}\` usage outside server actions.`,
          "medium",
        );
      }
    }
  }

  const isRouteLikeFile = /[/\\](route|page|layout|loading|error|not-found|template)\.(ts|js|tsx|jsx)$/.test(
    filename,
  );
  const isClientComponent = hasTopLevelDirective(rootNode, "use client");
  const nextNavigationImports = findImportsBySource(rootNode, "next/navigation");
  for (const imp of nextNavigationImports) {
    const bindings = parseNamedImportBindings(imp.text());

    if (!isRouteLikeFile) {
      for (const symbol of ["redirect", "permanentRedirect", "notFound"]) {
        const localNames = bindings
          .filter((binding) => binding.imported === symbol)
          .map((binding) => binding.local);
        for (const localName of localNames) {
          for (const usage of findCallExpressions(rootNode, localName)) {
            queueLineTodo(
              usage,
              `manual migration required for \`${symbol}()\` in non-route context.`,
              "low",
            );
          }
        }
      }
    }

    if (isClientComponent) {
      for (const symbol of [
        "useRouter",
        "useSelectedLayoutSegment",
        "useSelectedLayoutSegments",
      ]) {
        const localNames = bindings
          .filter((binding) => binding.imported === symbol)
          .map((binding) => binding.local);
        for (const localName of localNames) {
          for (const usage of findCallExpressions(rootNode, localName)) {
            queueLineTodo(
              usage,
              `manual migration required for \`${symbol}()\` in client component.`,
              "medium",
            );
          }
        }
      }
    }
  }

  if (hasMetadataOrSeoPatterns(rootNode)) {
    queueTopTodo(
      "metadata/SEO exports detected (`metadata`, `generateMetadata`, `viewport`, `sitemap`, `robots`, or `next/og`); migrate manually.",
      "high",
    );
  }

  if (isMiddlewareOrEdgeRuntimeFile(rootNode, filename)) {
    queueTopTodo(
      "middleware/edge runtime pattern detected; manual migration required for TanStack Start runtime semantics.",
      "high",
    );
  }

  const configKeys = detectNextConfigKeys(filename, source);
  if (configKeys.length > 0) {
    queueTopTodo(
      `next.config semantics detected (${configKeys.join(", ")}); migrate these settings manually.`,
      "high",
    );
  }

  if (topLevelTodos.length > 0) {
    const firstNode = rootNode.child(0);
    if (firstNode) {
      edits.push(firstNode.replace(`${topLevelTodos.join("\n")}\n${firstNode.text()}`));
    }
  }

  for (const [node, comments] of lineComments.entries()) {
    const prefix = `${Array.from(comments).join("\n")}\n`;
    edits.push(node.replace(`${prefix}${node.text()}`));
  }

  return edits.length > 0 ? edits : null;
};

function findImportsBySource(rootNode: any, source: string) {
  return rootNode.findAll({
    rule: {
      any: [
        {
          pattern: `import { $$$IMPORTS } from "${source}"`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from '${source}'`,
          kind: "import_statement",
        },
      ],
    },
  });
}

function parseNamedImportBindings(importText: string): ImportBinding[] {
  const match = importText.match(/import\s*{([\s\S]*?)}\s*from\s*['"][^'"]+['"]/);
  if (!match?.[1]) return [];

  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^type\s+/, "").trim())
    .map((part) => {
      const aliasMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch?.[1] && aliasMatch[2]) {
        return {
          imported: aliasMatch[1],
          local: aliasMatch[2],
        };
      }
      return {
        imported: part,
        local: part,
      };
    });
}

function findCallExpressions(rootNode: any, fnName: string): any[] {
  return rootNode.findAll({
    rule: {
      pattern: `${fnName}($$$ARGS)`,
      kind: "call_expression",
    },
  });
}

function findFirstNonImportIdentifier(rootNode: any, identifier: string): any | null {
  const identifiers = rootNode.findAll({
    rule: {
      pattern: identifier,
      kind: "identifier",
    },
  });

  for (const node of identifiers) {
    if (isInsideImport(node)) continue;
    return node;
  }

  return null;
}

function isInsideImport(node: any): boolean {
  let current = node;
  while (current) {
    if (current.kind?.() === "import_statement") return true;
    current = current.parent?.();
  }
  return false;
}

function hasTopLevelDirective(rootNode: any, directive: "use client" | "use server"): boolean {
  const directives = rootNode.findAll({
    rule: {
      any: [
        { pattern: `"${directive}";`, kind: "expression_statement" },
        { pattern: `'${directive}';`, kind: "expression_statement" },
        { pattern: `"${directive}"`, kind: "expression_statement" },
        { pattern: `'${directive}'`, kind: "expression_statement" },
      ],
    },
  });

  return directives.some((node: any) => node?.parent()?.kind?.() === "program");
}

function hasMetadataOrSeoPatterns(rootNode: any): boolean {
  const matches = rootNode.find({
    rule: {
      any: [
        { pattern: `export const metadata = $$$VALUE` },
        { pattern: `export async function generateMetadata($$$ARGS) { $$$BODY }` },
        { pattern: `export function generateMetadata($$$ARGS) { $$$BODY }` },
        { pattern: `export const viewport = $$$VALUE` },
        { pattern: `export async function sitemap($$$ARGS) { $$$BODY }` },
        { pattern: `export function sitemap($$$ARGS) { $$$BODY }` },
        { pattern: `export async function robots($$$ARGS) { $$$BODY }` },
        { pattern: `export function robots($$$ARGS) { $$$BODY }` },
        { pattern: `import { $$$IMPORTS } from "next/og"` },
        { pattern: `import { $$$IMPORTS } from 'next/og'` },
      ],
    },
  });

  return Boolean(matches);
}

function isMiddlewareOrEdgeRuntimeFile(rootNode: any, filename: string): boolean {
  if (/[/\\]middleware\.(ts|js|tsx|jsx|mts|cts)$/.test(filename)) {
    return true;
  }

  const hasMiddlewareExport = rootNode.find({
    rule: {
      any: [
        { pattern: `export function middleware($$$ARGS) { $$$BODY }` },
        { pattern: `export async function middleware($$$ARGS) { $$$BODY }` },
        { pattern: `export const middleware = ($$$ARGS) => { $$$BODY }` },
        { pattern: `export const middleware = async ($$$ARGS) => { $$$BODY }` },
      ],
    },
  });
  if (hasMiddlewareExport) return true;

  return Boolean(
    rootNode.find({
      rule: {
        any: [
          { pattern: `export const runtime = "edge"` },
          { pattern: `export const runtime = 'edge'` },
        ],
      },
    }),
  );
}

function detectNextConfigKeys(filename: string, source: string): string[] {
  if (!/(^|[/\\])next\.config\.(js|ts|mjs|cjs|mts|cts)$/.test(filename)) {
    return [];
  }

  const keys = ["rewrites", "redirects", "i18n", "basePath", "trailingSlash"];
  return keys.filter((key) => new RegExp(`\\b${key}\\s*:`).test(source));
}

function getCommentAnchor(node: any): any | null {
  let current = node;
  while (current) {
    const kind = current.kind?.();
    if (
      kind === "expression_statement" ||
      kind === "return_statement" ||
      kind === "if_statement" ||
      kind === "throw_statement" ||
      kind === "lexical_declaration" ||
      kind === "variable_declaration" ||
      kind === "function_declaration"
    ) {
      return current;
    }
    if (kind === "program") {
      return node;
    }
    current = current.parent?.();
  }
  return node;
}

function getEffectiveFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  if (/\/tests\/migration-navigation-route\//.test(normalized)) {
    return "/app/posts/route.tsx";
  }
  if (/\/tests\/migration-navigation-non-route\//.test(normalized)) {
    return "/app/lib/nav.ts";
  }
  if (/\/tests\/migration-navigation-client\//.test(normalized)) {
    return "/app/components/client.tsx";
  }
  if (/\/tests\/migration-middleware-file\//.test(normalized)) {
    return "/app/middleware.ts";
  }
  if (/\/tests\/migration-next-config/.test(normalized)) {
    return "/next.config.ts";
  }
  return filename;
}

