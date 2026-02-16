import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextApiRouteTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const filename = root.filename();

  // Only process route.ts/route.js files
  if (!filename.match(/route\.(ts|js|tsx|jsx)$/)) {
    return null;
  }

  // Detect HTTP method handlers
  const httpMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ];
  const methodHandlers: Array<{
    method: string;
    params: string;
    body: string;
    hasRequestParam: boolean;
    hasContextParam: boolean;
    node: any;
  }> = [];

  // Find all exported async functions for HTTP methods
  for (const method of httpMethods) {
    // Pattern: export async function METHOD(request, context?) { ... }
    const methodFunctions = rootNode.findAll({
      rule: {
        any: [
          {
            pattern: `export async function ${method}($$$PARAMS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export function ${method}($$$PARAMS) { $$$BODY }`,
            kind: "export_statement",
          },
          {
            pattern: `export async function ${method}($$$PARAMS) { $$$BODY }`,
            kind: "function_declaration",
          },
          {
            pattern: `export function ${method}($$$PARAMS) { $$$BODY }`,
            kind: "function_declaration",
          },
        ],
      },
    });

    for (const func of methodFunctions) {
      const paramsNode = func.getMultipleMatches("PARAMS");
      const bodyNode = func.getMultipleMatches("BODY");

      const params = paramsNode.map((p: any) => p.text()).join(", ");
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const paramList = params.split(",").map((p) => p.trim());
      const hasRequestParam = paramList.some(
        (p) =>
          p.includes("request") || p.includes("req") || p.includes("Request"),
      );
      const hasContextParam = paramList.some(
        (p) =>
          p.includes("context") || p.includes("ctx") || p.includes("params"),
      );

      methodHandlers.push({
        method,
        params,
        body,
        hasRequestParam,
        hasContextParam,
        node: func,
      });
    }
  }

  if (methodHandlers.length === 0) {
    return null;
  }

  // Transform Next.js specific imports
  const importReplacements = new Map<any, string | null>();
  const hasNextOgImageResponseImport = Boolean(
    rootNode
      .find({
        rule: {
          any: [
            {
              pattern: `import { $$$IMPORTS } from "next/og"`,
              kind: "import_statement",
            },
            {
              pattern: `import { $$$IMPORTS } from 'next/og'`,
              kind: "import_statement",
            },
          ],
        },
      })
      ?.getMultipleMatches("IMPORTS")
      ?.some((i: any) => i.text().includes("ImageResponse")),
  );
  const nextImports = rootNode.findAll({
    rule: {
      any: [
        {
          pattern: `import { $$$IMPORTS } from "next/server"`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from 'next/server'`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from "next/headers"`,
          kind: "import_statement",
        },
        {
          pattern: `import { $$$IMPORTS } from 'next/headers'`,
          kind: "import_statement",
        },
      ],
    },
  });

  for (const imp of nextImports) {
    const imports = imp.getMultipleMatches("IMPORTS").map((i: any) => i.text());
    const importSource = imp.text().includes("next/server")
      ? "server"
      : "headers";

    if (importSource === "server") {
      if (hasNextOgImageResponseImport) {
        // Preserve Next.js server types when ImageResponse is in use.
        continue;
      }
      // Check for NextRequest/NextResponse usage
      const hasNextRequest = imports.some((i: string) =>
        i.includes("NextRequest"),
      );
      const hasNextResponse = imports.some((i: string) =>
        i.includes("NextResponse"),
      );

      if (hasNextRequest || hasNextResponse) {
        // Replace with standard Web APIs comment
        importReplacements.set(
          imp,
          `// Migrated from Next.js: NextRequest/NextResponse replaced with standard Web Request/Response APIs`,
        );
      } else {
        importReplacements.set(imp, null);
      }
    } else {
      // next/headers - replace with TanStack server utilities
      importReplacements.set(
        imp,
        `import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";`,
      );
    }
  }

  // Calculate the route path from filename
  // e.g., app/api/users/route.ts -> /api/users
  // e.g., app/api/users/[id]/route.ts -> /api/users/$id
  const routePath = calculateRoutePath(filename);

  // Generate TanStack Start server route
  const handlersCode = methodHandlers
    .map((handler) => {
      const transformedBody = transformHandlerBody(
        handler.body,
        handler.hasRequestParam,
        handler.hasContextParam,
        hasNextOgImageResponseImport,
      );

      return `      ${handler.method}: async ({ request, params }) => {
${indent(transformedBody, 8)}
      }`;
    })
    .join(",\n");

  const tanstackRoute = `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('${routePath}')({
  server: {
    handlers: {
${handlersCode}
    }
  }
})`;

  // Remove Next.js runtime directives not applicable to Start
  const dynamicExports = rootNode.findAll({
    rule: {
      any: [
        { pattern: `export const dynamic = "force-static";` },
        { pattern: `export const dynamic = 'force-static';` },
      ],
      kind: "export_statement",
    },
  });
  for (const node of dynamicExports) {
    edits.push(node.replace(""));
  }

  // Apply import replacements
  for (const [imp, replacement] of importReplacements.entries()) {
    edits.push(imp.replace(replacement ?? ""));
  }

  // Insert route where the first handler was to avoid import conflicts
  const firstHandler = methodHandlers[0]?.node;
  if (firstHandler) {
    for (const _ of methodHandlers) {
      migrationMetric.increment({ bucket: "automated", effort: "medium" });
    }
    edits.push(firstHandler.replace(tanstackRoute));
    for (let i = 1; i < methodHandlers.length; i += 1) {
      const handler = methodHandlers[i];
      if (handler) edits.push(handler.node.replace(""));
    }
  }

  return edits.length > 0 ? edits : null;
};

// Helper to calculate TanStack route path from file path
function calculateRoutePath(filename: string): string {
  // Normalize to POSIX separators for consistent matching
  let path = filename.replace(/\\/g, "/");

  // Remove Windows drive prefix if present (e.g. C:)
  path = path.replace(/^[A-Za-z]:/, "");

  // Remove everything before app/ or src/app/ if present
  const appIndex = path.search(/(?:^|\/)(?:src\/)?app\//);
  if (appIndex !== -1) {
    const appMatch = path.match(/(?:^|\/)(?:src\/)?app\//);
    if (appMatch) {
      path = path.slice(appIndex + appMatch[0].length);
    }
  } else {
    // Fallback: anchor at /api/ if app/ is not present
    const apiIndex = path.indexOf("/api/");
    if (apiIndex !== -1) {
      path = path.slice(apiIndex + 1);
    }
  }

  // Remove file extension and 'route' suffix
  path = path.replace(/route\.(ts|js|tsx|jsx)$/, "");

  // Convert route groups: (group) -> _group (pathless layout segment)
  path = path.replace(/\(([^)]+)\)/g, "_$1");

  // Convert optional catch-all [[...slug]] to $
  path = path.replace(/\[\[\.\.\.([^\]]+)\]\]/g, "$$");

  // Convert catch-all [...slug] to $ (splat) first
  path = path.replace(/\[\.\.\.([^\]]+)\]/g, "$$");

  // Convert Next.js dynamic segments [id] to TanStack $id
  path = path.replace(/\[([^\]]+)\]/g, "$$$1");

  // Ensure leading slash
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  // Remove trailing slash
  path = path.replace(/\/$/, "");

  return path || "/";
}

// Transform handler body from Next.js to TanStack patterns
function transformHandlerBody(
  body: string,
  hasRequest: boolean,
  hasContext: boolean,
  preserveNextResponse: boolean,
): string {
  let transformed = body;

  if (!preserveNextResponse) {
    // Transform NextResponse.json() to standard Response.json()
    transformed = transformed.replace(
      /NextResponse\.json\(([^)]+)\)/g,
      "Response.json($1)",
    );

    // Transform NextResponse with status
    transformed = transformed.replace(
      /NextResponse\.json\(([^,]+),\s*\{\s*status:\s*(\d+)\s*\}\)/g,
      "Response.json($1, { status: $2 })",
    );

    // Transform new NextResponse() to new Response()
    transformed = transformed.replace(/new\s+NextResponse\(/g, "new Response(");
  }

  // Transform context.params access to direct params access
  if (hasContext) {
    transformed = transformed.replace(
      /(?:await\s+)?(?:context\.)?params/g,
      "params",
    );
  }

  // Transform cookies() from next/headers
  transformed = transformed.replace(
    /await\s+cookies\(\)/g,
    "{ get: (name) => getRequestHeader('cookie')?.match(new RegExp(name + '=([^;]+)'))?.[1] }",
  );

  // Transform headers() from next/headers
  transformed = transformed.replace(/await\s+headers\(\)/g, "request.headers");

  // Add return statement if missing (Next.js often implies return)
  if (
    !transformed.trim().startsWith("return") &&
    !transformed.includes("return ")
  ) {
    // Check if it's setting a response variable
    const responseMatch = transformed.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:NextResponse|Response)\./,
    );
    if (responseMatch) {
      transformed = transformed.replace(
        new RegExp(`${responseMatch[1]};?\\s*$`),
        `return ${responseMatch[1]};`,
      );
    }
  }

  return transformed;
}

function indent(str: string, spaces: number): string {
  const indentStr = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.trim() ? indentStr + line : line))
    .join("\n");
}

// Handle route.ts files with default export (less common in Next.js but possible)
export const nextDefaultExportApiTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const filename = root.filename();

  if (!filename.match(/route\.(ts|js|tsx|jsx)$/)) {
    return null;
  }

  // Look for default export with HTTP methods as properties
  const defaultExport = rootNode.find({
    rule: {
      pattern: `export default { $$$METHODS }`,
      kind: "export_statement",
    },
  });

  if (!defaultExport) return null;

  const methodsNode = defaultExport.getMultipleMatches("METHODS");
  const methodsText = methodsNode.map((m: any) => m.text()).join("\n");

  // Parse methods from object notation
  const methodMatches = methodsText.matchAll(
    /(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*:\s*(async\s+)?\([^)]*\)\s*=>\s*(\{[^}]*\}|[^,]+)/g,
  );
  const handlers: string[] = [];

  for (const match of methodMatches) {
    const method = match[1];
    const handlerBody = match[3];
    handlers.push(`      ${method}: async ({ request, params }) => {
        ${handlerBody}
      }`);
  }

  if (handlers.length === 0) return null;

  const routePath = calculateRoutePath(filename);
  const tanstackRoute = `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('${routePath}')({
  server: {
    handlers: {
${handlers.join(",\n")}
    }
  }
})`;

  edits.push(defaultExport.replace(tanstackRoute));
  return edits;
};
