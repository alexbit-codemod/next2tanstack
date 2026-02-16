import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextToTanstackFileStructureTransform: SubTranform = async (
  root,
) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const filename = root.filename();
  const effectiveFilename = getEffectiveFilename(filename);
  const tanstackImportSpecifiers = new Set<string>();
  let tanstackImportMerged = false;

  if (
    filename.includes("node_modules") ||
    (!effectiveFilename.includes("/app/") &&
      !effectiveFilename.includes("\\app\\"))
  ) {
    return null;
  }

  if (shouldSkipAutomaticRouteTransform(effectiveFilename)) {
    migrationMetric.increment({ bucket: "blocked" });
    return null;
  }

  if (
    effectiveFilename.includes(".route.") ||
    effectiveFilename.includes("__root.")
  ) {
    return null;
  }

  // Transform 1: page.tsx -> index.tsx
  if (effectiveFilename.match(/page\.(tsx|jsx|ts|js)$/)) {
    tanstackImportSpecifiers.add("createFileRoute");

    // Update default export to Route export
    const defaultExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (defaultExport) {
      const nameNode = defaultExport.getMatch("NAME");
      const propsNode = defaultExport.getMultipleMatches("PROPS");
      const bodyNode = defaultExport.getMultipleMatches("BODY");

      const name = nameNode?.text() || "Page";
      const props = propsNode.map((p: any) => p.text()).join(", ");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const isAsync = defaultExport.text().includes("async function");
      // Transform to TanStack Route component
      const tanstackRoute = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  component: ${name},
})

${buildRouteComponent(name, props, body, isAsync)}`;

      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      edits.push(defaultExport.replace(tanstackRoute));
    }

    // Also handle arrow function exports
    const arrowExport = rootNode.find({
      rule: {
        pattern: `export default ($$$PROPS) => { $$$BODY }`,
        kind: "export_statement",
      },
    });

    if (arrowExport && !defaultExport) {
      tanstackImportSpecifiers.add("createFileRoute");
      const propsNode = arrowExport.getMultipleMatches("PROPS");
      const bodyNode = arrowExport.getMultipleMatches("BODY");

      const props = propsNode.map((p: any) => p.text()).join(", ");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const tanstackRoute = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  component: RouteComponent,
})

${buildRouteComponent("RouteComponent", props, body, false)}`;

      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      edits.push(arrowExport.replace(tanstackRoute));
    }
  }

  // Transform 2: layout.tsx -> __root.tsx (for root) or _layout.tsx (for nested)
  if (effectiveFilename.match(/layout\.(tsx|jsx|ts|js)$/)) {
    const isRootLayout =
      !effectiveFilename.match(/[\\/]app[\\/](?!.*[\\/]).*layout\./) &&
      (effectiveFilename.includes("app/layout.") ||
        effectiveFilename.includes("app\\layout."));

    // Transform layout export
    const layoutExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (layoutExport) {
      const propsNode = layoutExport.getMultipleMatches("PROPS");
      const bodyNode = layoutExport.getMultipleMatches("BODY");
      const props = propsNode.map((p: any) => p.text()).join(", ");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const isAsync = layoutExport.text().includes("async function");
      if (isRootLayout) {
        tanstackImportSpecifiers.add("createRootRoute");
        tanstackImportSpecifiers.add("Outlet");
        // Root layout becomes __root.tsx with Outlet
        const rootRoute = `export const Route = createRootRoute({
  component: RootComponent,
})

${buildRouteComponent(
  "RootComponent",
  "",
  body
    .replace(/{\s*children\s*}/g, "<Outlet />")
    .replace(/props\.children/g, "<Outlet />"),
  isAsync,
)}`;

        migrationMetric.increment({ bucket: "automated", effort: "medium" });
        edits.push(layoutExport.replace(rootRoute));
      } else {
        tanstackImportSpecifiers.add("createFileRoute");
        tanstackImportSpecifiers.add("Outlet");
        // Nested layout becomes _layout.tsx
        const layoutRoute = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  component: LayoutComponent,
})

${buildRouteComponent(
  "LayoutComponent",
  props,
  body
    .replace(/{\s*children\s*}/g, "<Outlet />")
    .replace(/props\.children/g, "<Outlet />"),
  isAsync,
)}`;

        migrationMetric.increment({ bucket: "automated", effort: "medium" });
        edits.push(layoutExport.replace(layoutRoute));
      }
    }
  }

  // Transform 3: loading.tsx -> -pending.tsx (TanStack's pending component convention)
  if (effectiveFilename.match(/loading\.(tsx|jsx|ts|js)$/)) {
    const loadingExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (loadingExport) {
      tanstackImportSpecifiers.add("createFileRoute");
      const bodyNode = loadingExport.getMultipleMatches("BODY");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const isAsync = loadingExport.text().includes("async function");
      const pendingComponent = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  pendingComponent: PendingComponent,
})

${buildRouteComponent("PendingComponent", "", body, isAsync)}`;

      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      edits.push(loadingExport.replace(pendingComponent));
    }
  }

  // Transform 4: error.tsx -> -error.tsx
  if (effectiveFilename.match(/error\.(tsx|jsx|ts|js)$/)) {
    const errorExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (errorExport) {
      tanstackImportSpecifiers.add("createFileRoute");
      const propsNode = errorExport.getMultipleMatches("PROPS");
      const bodyNode = errorExport.getMultipleMatches("BODY");
      const props = propsNode.map((p: any) => p.text()).join(", ");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const isAsync = errorExport.text().includes("async function");
      const errorComponent = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  errorComponent: RouteErrorComponent,
})

${buildRouteComponent("RouteErrorComponent", props, body, isAsync)}`;

      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      edits.push(errorExport.replace(errorComponent));
    }
  }

  // Transform 5: not-found.tsx -> -not-found.tsx
  if (effectiveFilename.match(/not-found\.(tsx|jsx|ts|js)$/)) {
    const notFoundExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (notFoundExport) {
      tanstackImportSpecifiers.add("createFileRoute");
      const bodyNode = notFoundExport.getMultipleMatches("BODY");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const isAsync = notFoundExport.text().includes("async function");
      const notFoundComponent = `export const Route = createFileRoute('${calculateTanstackRoute(effectiveFilename)}')({
  notFoundComponent: NotFoundComponent,
})

${buildRouteComponent("NotFoundComponent", "", body, isAsync)}`;

      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      edits.push(notFoundExport.replace(notFoundComponent));
    }
  }

  // Transform 6: template.tsx -> manual migration TODO (TanStack Start has no direct template equivalent)
  if (effectiveFilename.match(/template\.(tsx|jsx|ts|js)$/)) {
    const templateExport = rootNode.find({
      rule: {
        any: [
          {
            pattern: `export default async function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        ],
      },
    });

    if (templateExport) {
      const templateText = templateExport.text();
      if (!templateText.includes("TODO: Next.js template.tsx")) {
        migrationMetric.increment({ bucket: "manual", effort: "high" });
        edits.push(
          templateExport.replace(
            `// TODO: Next.js template.tsx has no direct TanStack Start equivalent. Migrate manually.
${templateText}`,
          ),
        );
      }
    }
  }

  // Transform 7: Update dynamic route imports and params usage
  const dynamicParamsUsage = rootNode.findAll({
    rule: {
      pattern: `await params.$PARAM`,
      kind: "await_expression",
    },
  });

  for (const usage of dynamicParamsUsage) {
    const paramNode = usage.getMatch("PARAM");
    if (paramNode) {
      const paramName = paramNode.text();
      // Next.js 15+ params are async, TanStack params are synchronous
      edits.push(usage.replace(`params.${paramName}`));
    }
  }

  // Transform 8: searchParams handling
  const hasUseSearch = rootNode.find({
    rule: { pattern: `useSearch($$$ARGS)`, kind: "call_expression" },
  });
  if (hasUseSearch) {
    const searchParamsUsage = rootNode.findAll({
      rule: {
        pattern: `searchParams.$PARAM`,
        kind: "member_expression",
      },
    });

    for (const usage of searchParamsUsage) {
      // TanStack uses useSearch hook instead of searchParams prop
      edits.push(usage.replace(`search.${usage.getMatch("PARAM")?.text()}`));
    }
  }

  // Transform 9: Update useRouter, usePathname, useSearchParams
  const nextRouterHooks = rootNode.findAll({
    rule: {
      any: [
        {
          pattern: `import { $$$IMPORTS } from "next/navigation"`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from 'next/navigation'`,
          kind: "import_statement",
        },
      ],
    },
  });

  for (const imp of nextRouterHooks) {
    const imports = parseImportSpecifiers(imp.text());
    const tanstackImports: string[] = [];
    const remainingImports: string[] = [];
    let needsUsePathnameRename = false;
    let needsUseSearchParamsRename = false;

    for (const importName of imports) {
      const trimmed = importName.trim();
      if (/^useRouter(\s+as\s+.+)?$/.test(trimmed)) {
        tanstackImports.push(trimmed);
        continue;
      }
      if (/^usePathname(\s+as\s+.+)?$/.test(trimmed)) {
        tanstackImports.push(trimmed.replace(/^usePathname/, "useLocation"));
        needsUsePathnameRename = true;
        continue;
      }
      if (/^useSearchParams(\s+as\s+.+)?$/.test(trimmed)) {
        tanstackImports.push(trimmed.replace(/^useSearchParams/, "useSearch"));
        needsUseSearchParamsRename = true;
        continue;
      }
      if (/^notFound(\s+as\s+.+)?$/.test(trimmed)) {
        tanstackImports.push(trimmed);
        continue;
      }
      remainingImports.push(trimmed);
    }

    const replacementLines: string[] = [];
    if (remainingImports.length > 0) {
      replacementLines.push(
        `import { ${remainingImports.join(", ")} } from "next/navigation"`,
      );
    }
    if (tanstackImports.length > 0) {
      if (!tanstackImportMerged && tanstackImportSpecifiers.size > 0) {
        for (const spec of tanstackImportSpecifiers) {
          tanstackImports.push(spec);
        }
        tanstackImportSpecifiers.clear();
        tanstackImportMerged = true;
      }
      replacementLines.push(
        `import { ${[...new Set(tanstackImports)].join(", ")} } from "@tanstack/react-router"`,
      );
    }

    if (replacementLines.length > 0) {
      edits.push(imp.replace(replacementLines.join("\n")));
    }

    if (needsUsePathnameRename) {
      const callSites = rootNode.findAll({
        rule: { pattern: `usePathname()`, kind: "call_expression" },
      });
      for (const call of callSites) {
        edits.push(call.replace("useLocation().pathname"));
      }
    }

    if (needsUseSearchParamsRename) {
      const callSites = rootNode.findAll({
        rule: { pattern: `useSearchParams()`, kind: "call_expression" },
      });
      for (const call of callSites) {
        edits.push(call.replace("useSearch()"));
      }
    }
  }

  if (tanstackImportSpecifiers.size > 0) {
    ensureTanstackImport(rootNode, edits, [...tanstackImportSpecifiers]);
  }

  return edits.length > 0 ? edits : null;
};

function shouldSkipAutomaticRouteTransform(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  const appIdx = normalized.indexOf("/app/");
  if (appIdx === -1) return false;

  const relPath = normalized.slice(appIdx + "/app/".length);
  const relSegments = relPath.split("/").filter(Boolean);
  const fileBase = relSegments[relSegments.length - 1] ?? "";
  const dirSegments = relSegments.slice(0, -1);

  const hasPrivateSegment = dirSegments.some((segment) =>
    /^_[^/]+$/.test(segment),
  );
  const hasParallelSegment = dirSegments.some((segment) =>
    /^@[^/]+$/.test(segment),
  );
  const hasRouteGroupSegment = dirSegments.some((segment) =>
    /^\([^)]+\)$/.test(segment),
  );
  const isGroupOnlyBranch =
    dirSegments.length > 0 &&
    dirSegments.every((segment) => /^\([^)]+\)$/.test(segment));
  const isLayoutLikeFile = /^(layout|template)\.(tsx|jsx|ts|js)$/.test(
    fileBase,
  );

  if (hasPrivateSegment || hasParallelSegment) return true;
  if (hasRouteGroupSegment && isLayoutLikeFile && !isGroupOnlyBranch)
    return true;
  return false;
}

// Helper function to calculate TanStack route path from filename
function calculateTanstackRoute(filename: string): string {
  const normalizedFilename = filename.replace(/\\/g, "/");
  // Remove file extension and special file names
  let path = normalizedFilename
    .replace(
      /(page|layout|loading|error|not-found|template|route)\.(tsx|jsx|ts|js)$/,
      "",
    )
    .replace(/\/$/, "");

  // Extract path after app/
  const appMatch = path.match(/[\\/]app[\\/](.+)/);
  if (appMatch) {
    path = appMatch[1] ?? "";
  } else {
    path = path.replace(/.*[\\/](src[\\/])?app[\\/]?/, "");
  }

  // Transform Next.js conventions to TanStack
  // (group) -> _group (pathless layout)
  path = path.replace(/\(([^)]+)\)/g, "_$1");

  // [[...optional]] -> $ (optional catchall becomes required in TanStack, handle manually)
  path = path.replace(/\[\[\.\.\.[^\]]+\]\]/g, "$$");

  // [...catchall] -> $
  path = path.replace(/\[\.\.\.[^\]]+\]/g, "$$");

  // [param] -> $param
  path = path.replace(/\[([^\]]+)\]/g, "$$$1");

  // Ensure leading slash
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  // Remove trailing slash
  path = path.replace(/\/$/, "");

  return path || "/";
}

function indent(str: string, spaces: number): string {
  const indentStr = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.trim() ? indentStr + line : line))
    .join("\n");
}

function buildRouteComponent(
  name: string,
  props: string,
  body: string,
  isAsync: boolean,
): string {
  let safeName = name.trim();
  let asyncFlag = isAsync;
  if (safeName.startsWith("async ")) {
    asyncFlag = true;
    safeName = safeName.replace(/^async\s+/, "");
  }
  const asyncPrefix = asyncFlag ? "async " : "";
  const trimmedProps = props.trim();
  const signature = trimmedProps.length > 0 ? `(${trimmedProps})` : "()";
  return `${asyncPrefix}function ${safeName}${signature} {
${indent(body, 2)}
}`;
}

function parseImportSpecifiers(importText: string): string[] {
  const match = importText.match(/\{([^}]*)\}/);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getEffectiveFilename(filename: string): string {
  if (/[\\/]tests[\\/]route-renames[\\/]/.test(filename)) {
    return filename
      .replace(/[\\/]tests[\\/]route-renames[\\/]/, "/app/")
      .replace(/input\.(tsx|jsx|ts|js)$/, "page.$1");
  }
  return filename;
}

function ensureTanstackImport(
  rootNode: any,
  edits: Edit[],
  specifiers: string[],
): void {
  if (specifiers.length === 0) return;

  const tanstackImport = rootNode.find({
    rule: {
      any: [
        {
          pattern: `import { $$$IMPORTS } from "@tanstack/react-router"`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from '@tanstack/react-router'`,
          kind: "import_statement",
        },
      ],
    },
  });

  if (tanstackImport) {
    const existing = tanstackImport
      .getMultipleMatches("IMPORTS")
      .map((i: any) => i.text().trim());
    const merged = new Set([...existing, ...specifiers]);
    const updated = `import { ${[...merged].join(", ")} } from "@tanstack/react-router"`;
    if (updated !== tanstackImport.text()) {
      edits.push(tanstackImport.replace(updated));
    }
    return;
  }

  insertAtTop(
    rootNode,
    edits,
    `import { ${[...new Set(specifiers)].join(", ")} } from "@tanstack/react-router"`,
  );
}

function insertAtTop(rootNode: any, edits: Edit[], text: string): void {
  const useClient = rootNode.find({
    rule: {
      any: [
        { pattern: `"use client";`, kind: "expression_statement" },
        { pattern: `'use client';`, kind: "expression_statement" },
        { pattern: `"use client"`, kind: "expression_statement" },
        { pattern: `'use client'`, kind: "expression_statement" },
      ],
    },
  });

  if (useClient) {
    edits.push(useClient.replace(`${useClient.text()}\n${text}`));
    return;
  }

  const firstImport = rootNode.find({ rule: { kind: "import_statement" } });
  if (firstImport) {
    edits.push(firstImport.replace(`${text}\n${firstImport.text()}`));
    return;
  }

  const firstNode =
    rootNode.find({ rule: { kind: "export_statement" } }) ??
    rootNode.find({ rule: { kind: "lexical_declaration" } }) ??
    rootNode.find({ rule: { kind: "function_declaration" } }) ??
    rootNode.find({ rule: { kind: "class_declaration" } }) ??
    rootNode.find({ rule: { kind: "expression_statement" } });

  if (firstNode) {
    edits.push(firstNode.replace(`${text}\n${firstNode.text()}`));
  }
}

/**
 * Separate transform for handling route groups and parallel routes
 */
export const nextRouteGroupsTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const filename = root.filename();
  const tanstackImportSpecifiers = new Set<string>();

  // Handle (group) folders - convert to _group pathless layout
  if (filename.match(/\([^)]+\).*\.(tsx|jsx|ts|js)$/)) {
    const groupMatch = filename.match(/\(([^)]+)\)/);
    if (groupMatch) {
      const groupName = groupMatch[1];

      // If it's a layout file in a group, it becomes a pathless layout
      if (filename.includes("layout.")) {
        const layoutExport = rootNode.find({
          rule: {
            pattern: `export default function $NAME($$$PROPS) { $$$BODY }`,
            kind: "export_statement",
          },
        });

        if (layoutExport) {
          tanstackImportSpecifiers.add("createFileRoute");
          tanstackImportSpecifiers.add("Outlet");
          const bodyNode = layoutExport.getMultipleMatches("BODY");
          const body = bodyNode.map((b: any) => b.text()).join("\n");

          const pathlessLayout = `// Route group: ${groupName}
function ${groupName}Layout() {
${indent(body.replace(/{\s*children\s*}/g, "<Outlet />"), 2)}
}

export const Route = createFileRoute('${calculateTanstackRoute(filename)}')({
  component: ${groupName}Layout,
})`;

          migrationMetric.increment({ bucket: "automated", effort: "medium" });
          edits.push(layoutExport.replace(pathlessLayout));
        }
      }
    }
  }

  // Handle @parallel routes (parallel routes are complex, convert to layout with conditional)
  if (filename.includes("@")) {
    // Parallel routes in Next.js become conditional rendering in TanStack
    // Emit a non-destructive TODO at the top of the file.
    if (
      !rootNode.text().includes("Parallel routes @folder need manual migration")
    ) {
      const firstExport = rootNode.find({ rule: { kind: "export_statement" } });
      if (firstExport) {
        migrationMetric.increment({ bucket: "manual", effort: "high" });
        edits.push(
          firstExport.replace(
            `// TODO: Parallel routes @folder need manual migration
// Convert to conditional rendering or separate routes with layout composition
${firstExport.text()}`,
          ),
        );
      }
    }
  }

  if (tanstackImportSpecifiers.size > 0) {
    ensureTanstackImport(rootNode, edits, [...tanstackImportSpecifiers]);
  }

  return edits.length > 0 ? edits : null;
};

/**
 * Transform for API routes (already covered in previous codemod, but included for completeness)
 */
export const nextApiRoutesTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const filename = root.filename();
  const tanstackImportSpecifiers = new Set<string>();
  const methodNodes: any[] = [];

  // Only process route.ts files in app/api
  if (!filename.match(/route\.(ts|js)$/) || !filename.includes("/api/")) {
    return null;
  }

  const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const handlers: string[] = [];

  for (const method of httpMethods) {
    const methodFn = rootNode.find({
      rule: {
        pattern: `export async function ${method}($$$PARAMS) { $$$BODY }`,
        kind: "function_declaration",
      },
    });

    if (methodFn) {
      methodNodes.push(methodFn);
      const bodyNode = methodFn.getMultipleMatches("BODY");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      // Transform body
      const transformedBody = body
        .replace(/NextResponse\.json\(([^)]+)\)/g, "Response.json($1)")
        .replace(/NextResponse/g, "Response");

      handlers.push(`      ${method}: async ({ request, params }) => {
${indent(transformedBody, 8)}
      }`);
    }
  }

  if (handlers.length > 0) {
    tanstackImportSpecifiers.add("createFileRoute");
    const routePath = calculateTanstackRoute(filename).replace("/api", "");

    const apiRoute = `export const Route = createFileRoute('${routePath}')({
  server: {
    handlers: {
${handlers.join(",\n")}
    }
  }
})`;

    const firstMethod = methodNodes[0];
    if (firstMethod) {
      edits.push(firstMethod.replace(apiRoute));
      for (let i = 1; i < methodNodes.length; i += 1) {
        edits.push(methodNodes[i].replace(""));
      }
    }
  }

  if (tanstackImportSpecifiers.size > 0) {
    ensureTanstackImport(rootNode, edits, [...tanstackImportSpecifiers]);
  }

  return edits.length > 0 ? edits : null;
};
