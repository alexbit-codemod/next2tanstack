import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextServerFunctionTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];
  const firstTopLevelNode = rootNode.child(0);

  const nodeReplacements = new Map<any, string>();
  const getNodeText = (node: any) => nodeReplacements.get(node) ?? node.text();
  const replaceNode = (node: any, text: string) => {
    nodeReplacements.set(node, text);
  };
  const prefixNode = (node: any, prefix: string) => {
    replaceNode(node, `${prefix}${getNodeText(node)}`);
  };

  // Track if this file has server function transformations
  let hasServerDirective = false;
  let needsCreateServerFnImport = false;
  let firstServerFnTarget: any | null = null;
  let directiveUsedForImport: any | null = null;
  let needsUseServerFnImport = false;
  const hoistedServerFns: string[] = [];
  const isTopLevel = (node: any) => node?.parent()?.kind?.() === "program";
  let deferredImportForHoist = false;
  let deferredImportText = "";

  // Step 1: Detect "use server" directives, collect server functions
  const allUseServerDirectives = rootNode.findAll({
    rule: {
      any: [
        { pattern: `"use server";`, kind: "expression_statement" },
        { pattern: `'use server';`, kind: "expression_statement" },
        { pattern: `"use server"`, kind: "expression_statement" },
        { pattern: `'use server'`, kind: "expression_statement" },
      ],
    },
  });

  const topLevelUseServerDirectives = allUseServerDirectives.filter(
    (node: any) => isTopLevel(node),
  );

  if (topLevelUseServerDirectives.length > 0) {
    hasServerDirective = true;
  }

  // Step 2: Find async function declarations with 'use server' directive in body (inline server functions)
  const asyncFunctionsWithDirective = rootNode.findAll({
    rule: {
      any: [
        {
          pattern: `async function $NAME($$$PARAMS) { "use server"; $$$BODY }`,
          kind: "function_declaration",
        },
        {
          pattern: `async function $NAME($$$PARAMS): $RETURNS { "use server"; $$$BODY }`,
          kind: "function_declaration",
        },
        {
          pattern: `async function $NAME($$$PARAMS) { 'use server'; $$$BODY }`,
          kind: "function_declaration",
        },
        {
          pattern: `async function $NAME($$$PARAMS): $RETURNS { 'use server'; $$$BODY }`,
          kind: "function_declaration",
        },
      ],
    },
  });

  for (const func of asyncFunctionsWithDirective) {
    const nameNode = func.getMatch("NAME");
    const paramsText = extractParamsText(func);
    const bodyNode = func.getMultipleMatches("BODY");

    const name = nameNode?.text() || "anonymous";
    const params = paramsText;
    const body = bodyNode.map((b: any) => b.text()).join("\n");

    const targetNode =
      func.parent()?.kind() === "export_statement" ? func.parent() : func;
    const isExport = targetNode !== func;
    const serverFnCode = buildServerFnCode(name, params, body, isExport);
    migrationMetric.increment({ bucket: "automated", effort: "medium" });
    if (isTopLevel(targetNode)) {
      replaceNode(targetNode, serverFnCode);
    } else {
      hoistedServerFns.push(serverFnCode.trimEnd());
      replaceNode(targetNode, "");
    }
    needsCreateServerFnImport = true;
    if (!firstServerFnTarget && isTopLevel(targetNode)) {
      firstServerFnTarget = targetNode;
    }
  }

  // Step 3: Find arrow functions with 'use server' directive (exported const server functions)
  const arrowServerFunctions = rootNode.findAll({
    rule: {
      any: [
        {
          pattern: `export const $NAME = async ($$$PARAMS) => { "use server"; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `export const $NAME = async ($$$PARAMS): $RETURNS => { "use server"; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `export const $NAME = async ($$$PARAMS) => { 'use server'; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `export const $NAME = async ($$$PARAMS): $RETURNS => { 'use server'; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `const $NAME = async ($$$PARAMS) => { "use server"; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `const $NAME = async ($$$PARAMS): $RETURNS => { "use server"; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `const $NAME = async ($$$PARAMS) => { 'use server'; $$$BODY }`,
          kind: "lexical_declaration",
        },
        {
          pattern: `const $NAME = async ($$$PARAMS): $RETURNS => { 'use server'; $$$BODY }`,
          kind: "lexical_declaration",
        },
      ],
    },
  });

  for (const func of arrowServerFunctions) {
    const nameNode = func.getMatch("NAME");
    const paramsText = extractParamsText(func);
    const bodyNode = func.getMultipleMatches("BODY");

    const name = nameNode?.text() || "anonymous";
    const params = paramsText;
    const body = bodyNode.map((b: any) => b.text()).join("\n");
    const targetNode =
      func.parent()?.kind() === "export_statement" ? func.parent() : func;
    const isExport =
      targetNode !== func && (targetNode?.text().startsWith("export") ?? false);
    const serverFnCode = buildServerFnCode(name, params, body, isExport);
    migrationMetric.increment({ bucket: "automated", effort: "medium" });
    if (isTopLevel(targetNode)) {
      replaceNode(targetNode, serverFnCode);
    } else {
      hoistedServerFns.push(serverFnCode.trimEnd());
      replaceNode(targetNode, "");
    }
    needsCreateServerFnImport = true;
    if (!firstServerFnTarget && isTopLevel(targetNode)) {
      firstServerFnTarget = targetNode;
    }
  }

  // Step 4: Handle file-level "use server" files - transform all exported async functions
  if (hasServerDirective) {
    // File-level directive - transform all exported async functions
    const exportedAsyncFunctions = rootNode.findAll({
      rule: {
        any: [
          {
            pattern: `async function $NAME($$$PARAMS) { $$$BODY }`,
            kind: "function_declaration",
          },
          {
            pattern: `async function $NAME($$$PARAMS): $RETURNS { $$$BODY }`,
            kind: "function_declaration",
          },
          {
            pattern: `const $NAME = async ($$$PARAMS) => { $$$BODY }`,
            kind: "lexical_declaration",
          },
          {
            pattern: `const $NAME = async ($$$PARAMS): $RETURNS => { $$$BODY }`,
            kind: "lexical_declaration",
          },
        ],
      },
    });

    for (const func of exportedAsyncFunctions) {
      const parent = func.parent();
      if (!parent || parent.kind() !== "export_statement") {
        continue;
      }
      const nameNode = func.getMatch("NAME");
      const paramsText = extractParamsText(func);
      const bodyNode = func.getMultipleMatches("BODY");

      const name = nameNode?.text() || "anonymous";
      const params = paramsText;
      const body = bodyNode.map((b: any) => b.text()).join("\n");

      const targetNode = parent;
      if (nodeReplacements.has(targetNode)) {
        continue;
      }
      const serverFnCode = buildServerFnCode(name, params, body, true);
      migrationMetric.increment({ bucket: "automated", effort: "medium" });
      replaceNode(targetNode, serverFnCode);
      needsCreateServerFnImport = true;
      if (!firstServerFnTarget && isTopLevel(targetNode)) {
        firstServerFnTarget = targetNode;
      }
    }
  }

  // Step 5: Keep next/navigation, next/cache and next/headers imports unchanged.
  // Import migration is handled by dedicated transforms. Doing it here caused
  // dangling symbols in files where only server-action syntax should be updated.

  // Step 8: Transform usage in Client Components (files with "use client")
  const isClientComponent = rootNode.find({
    rule: {
      any: [
        { pattern: `"use client";`, kind: "expression_statement" },
        { pattern: `'use client';`, kind: "expression_statement" },
      ],
    },
  });

  if (isClientComponent) {
    // Find imports from server action files
    const serverActionImports = rootNode.findAll({
      rule: {
        any: [
          {
            pattern: `import { $$$IMPORTS } from $PATH`,
            kind: "import_statement",
          },
        ],
      },
      constraints: {
        PATH: { regex: ".*(actions|server|functions).*" },
      },
    });

    for (const imp of serverActionImports) {
      const imports = imp
        .getMultipleMatches("IMPORTS")
        .map((i: any) => i.text().trim());
      const pathNode = imp.getMatch("PATH");
      const path = pathNode?.text() || "";

      // Check if imported functions are used in forms or event handlers
      for (const importName of imports) {
        const rawImport = importName.replace(/^type\s+/, "").trim();
        const localName = rawImport.includes(" as ")
          ? rawImport
              .split(/\s+as\s+/)
              .pop()
              ?.trim()
          : rawImport;
        if (!localName || !/^[A-Za-z_$][\w$]*$/.test(localName)) {
          continue;
        }
        // Find form actions using the imported function
        const formActions = rootNode.findAll({
          rule: {
            pattern: `<form action={$ACTION}>$$$CHILDREN</form>`,
            kind: "jsx_element",
          },
        });

        for (const form of formActions) {
          const actionNode = form.getMatch("ACTION");
          if (actionNode?.text() !== localName) {
            continue;
          }
          // Transform to useServerFn pattern
          const children = form
            .getMultipleMatches("CHILDREN")
            .map((c: any) => c.text())
            .join("");

          migrationMetric.increment({ bucket: "automated", effort: "medium" });
          // Replace with onSubmit handler
          edits.push(
            form.replace(
              `<form onSubmit={async (e) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    await ${localName}({ data: formData });
  }}>${children}</form>`,
            ),
          );
        }

        // Find direct invocations like onClick={() => action()}
        const directInvocations = rootNode.findAll({
          rule: {
            pattern: `onClick={$EXPR}`,
            kind: "jsx_attribute",
          },
        });

        for (const invocation of directInvocations) {
          const exprText = invocation.getMatch("EXPR")?.text() ?? "";
          const safeLocalName = localName.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );
          const callMatch = exprText.match(
            new RegExp(
              `^\\s*\\(?\\s*(?:async\\s*)?\\(?[^)]*\\)?\\s*=>\\s*${safeLocalName}\\s*\\((.*)\\)\\s*$`,
            ),
          );
          if (!callMatch) {
            continue;
          }
          const args = callMatch[1] ?? "";
          const dataPayload = args.trim()
            ? `{ data: { ${args} } }`
            : `{ data: {} }`;
          replaceNode(
            invocation,
            `onClick={() => ${localName}(${dataPayload})}`,
          );
        }
      }
    }

    // Add useServerFn import if needed
    const hasUseServerFnUsage = rootNode.text().includes("useServerFn");
    if (hasUseServerFnUsage) {
      needsUseServerFnImport = true;
    }
  }

  // Step 8.5: In server-action files only, move notFound/redirect imports to TanStack
  const hasServerActionTransforms =
    needsCreateServerFnImport ||
    hoistedServerFns.length > 0 ||
    hasServerDirective;
  if (hasServerActionTransforms) {
    const nextNavigationImports = rootNode.findAll({
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

    for (const imp of nextNavigationImports) {
      const imports = imp
        .getMultipleMatches("IMPORTS")
        .map((i: any) => i.text().trim());
      const tanstackImports: string[] = [];
      const remainingImports: string[] = [];

      for (const name of imports) {
        const trimmed = name.trim();
        if (/^notFound(\s+as\s+.+)?$/.test(trimmed)) {
          tanstackImports.push(trimmed);
          continue;
        }
        if (/^redirect(\s+as\s+.+)?$/.test(trimmed)) {
          tanstackImports.push(trimmed);
          continue;
        }
        remainingImports.push(trimmed);
      }

      if (tanstackImports.length === 0) {
        continue;
      }

      const replacementLines: string[] = [];
      if (remainingImports.length > 0) {
        replacementLines.push(
          `import { ${remainingImports.join(", ")} } from "next/navigation";`,
        );
      }
      replacementLines.push(
        `import { ${[...new Set(tanstackImports)].join(", ")} } from "@tanstack/react-router";`,
      );

      replaceNode(imp, replacementLines.join("\n"));
    }
  }

  // Step 9: Ensure @tanstack/react-start imports
  const tanstackStartSpecifiers = new Set<string>();
  if (needsCreateServerFnImport) tanstackStartSpecifiers.add("createServerFn");
  if (needsUseServerFnImport) tanstackStartSpecifiers.add("useServerFn");

  if (tanstackStartSpecifiers.size > 0) {
    const existingTanstackImports = rootNode.findAll({
      rule: {
        pattern: `import { $$$IMPORTS } from "@tanstack/react-start"`,
        kind: "import_statement",
      },
    });

    if (existingTanstackImports.length > 0) {
      const importNode = existingTanstackImports[0]!;
      const imports = importNode
        .getMultipleMatches("IMPORTS")
        .map((i: any) => i.text());
      for (const spec of tanstackStartSpecifiers) {
        imports.push(spec);
      }
      const deduped = Array.from(new Set(imports));
      replaceNode(
        importNode,
        `import { ${deduped.join(", ")} } from "@tanstack/react-start";`,
      );
    } else {
      const newImport = `import { ${Array.from(tanstackStartSpecifiers).join(
        ", ",
      )} } from "@tanstack/react-start";\n`;
      const firstImport = rootNode.find({
        rule: { kind: "import_statement" },
      });

      if (firstImport) {
        prefixNode(firstImport, newImport);
      } else if (topLevelUseServerDirectives.length > 0) {
        directiveUsedForImport = topLevelUseServerDirectives[0];
        replaceNode(directiveUsedForImport, newImport.trimEnd());
      } else if (firstServerFnTarget) {
        prefixNode(firstServerFnTarget, newImport);
      } else if (firstTopLevelNode) {
        if (hoistedServerFns.length > 0) {
          deferredImportForHoist = true;
          deferredImportText = newImport;
        } else {
          prefixNode(firstTopLevelNode, newImport);
        }
      }
    }
  }

  // Hoist inline server functions to module scope (after imports)
  if (hoistedServerFns.length > 0) {
    const hoistedCode = `${hoistedServerFns.join("\n\n")}\n`;
    const importStatements = rootNode.findAll({
      rule: { kind: "import_statement" },
    });
    if (importStatements.length > 0) {
      const lastImport = importStatements[importStatements.length - 1];
      replaceNode(
        lastImport,
        `${getNodeText(lastImport)}\n\n${hoistedCode.trimEnd()}`,
      );
    } else if (topLevelUseServerDirectives.length > 0) {
      directiveUsedForImport = topLevelUseServerDirectives[0];
      replaceNode(directiveUsedForImport, hoistedCode.trimEnd());
    } else if (firstServerFnTarget) {
      prefixNode(firstServerFnTarget, hoistedCode);
    } else if (firstTopLevelNode) {
      if (deferredImportForHoist) {
        replaceNode(
          firstTopLevelNode,
          `${deferredImportText.trimEnd()}\n${hoistedCode.trimEnd()}\n${getNodeText(
            firstTopLevelNode,
          )}`,
        );
      } else {
        prefixNode(firstTopLevelNode, hoistedCode);
      }
    }
  }

  // Remove top-level "use server" directives (unless used for import insertion)
  if (allUseServerDirectives.length > 0) {
    for (const directive of allUseServerDirectives) {
      if (directiveUsedForImport && directive === directiveUsedForImport) {
        continue;
      }
      replaceNode(directive, "");
    }
  }

  for (const [node, text] of nodeReplacements.entries()) {
    edits.push(node.replace(text));
  }

  return edits.length > 0 ? edits : null;
};

// Helper functions
function transformServerFunctionBody(body: string, params: string): string {
  let transformed = body;

  // Remove any leftover "use server" directives
  transformed = transformed.replace(/["']use server["'];?/g, "");

  // Transform revalidatePath() calls to comments
  transformed = transformed.replace(
    /revalidatePath\(([^)]+)\);?/g,
    "// TODO: Replace with queryClient.invalidateQueries() - revalidatePath($1);",
  );

  // Transform revalidateTag() calls to comments
  transformed = transformed.replace(
    /revalidateTag\(([^)]+)\);?/g,
    "// TODO: Replace with queryClient.invalidateQueries() - revalidateTag($1);",
  );

  // Transform redirect() from next/navigation to TanStack
  transformed = transformed.replace(
    /import\s*{\s*redirect\s*}\s*from\s*["']next\/navigation["'];?/g,
    'import { redirect } from "@tanstack/react-router";',
  );

  // Transform cookies() usage
  transformed = transformed.replace(
    /const\s+(\w+)\s*=\s*await\s*cookies\(\);?/g,
    `// TODO: Replace cookies() with getRequestHeader("cookie") and a cookie parser
const $1 = (undefined as any);`,
  );
  transformed = transformed.replace(
    /const\s+(\w+)\s*=\s*cookies\(\);?/g,
    `// TODO: Replace cookies() with getRequestHeader("cookie") and a cookie parser
const $1 = (undefined as any);`,
  );

  // Transform headers() usage
  transformed = transformed.replace(
    /const\s+(\w+)\s*=\s*await\s*headers\(\);?/g,
    "const $1 = getRequest().headers;",
  );
  transformed = transformed.replace(
    /const\s+(\w+)\s*=\s*headers\(\);?/g,
    "const $1 = getRequest().headers;",
  );

  // Handle FormData extraction if formData is the param
  if (params.includes("formData") || params.includes("FormData")) {
    // Add FormData extraction logic at the start of body if not present
    if (!transformed.includes("data.get(")) {
      transformed = `// FormData is automatically validated\n${transformed}`;
    }
  }

  return transformed;
}

function buildServerFnCode(
  name: string,
  params: string,
  body: string,
  isExport: boolean,
): string {
  const manualTodoCount =
    (body.match(/revalidatePath\s*\(/g)?.length ?? 0) +
    (body.match(/revalidateTag\s*\(/g)?.length ?? 0) +
    (body.match(/(?:await\s+)?cookies\s*\(/g)?.length ?? 0);
  if (manualTodoCount > 0) {
    migrationMetric.increment(
      { bucket: "manual", effort: "medium" },
      manualTodoCount,
    );
  }
  const transformedBody = transformServerFunctionBody(body, params);
  const hasFormData =
    params.includes("formData") || params.includes("FormData");
  const prefix = isExport ? "export const" : "const";

  if (hasFormData) {
    return generateFormDataServerFn(name, transformedBody, prefix);
  }
  if (params && params.trim().length > 0) {
    return generateParamsServerFn(name, params, transformedBody, prefix);
  }
  return `${prefix} ${name} = createServerFn({ method: "POST" })
  .handler(async () => {
${indent(transformedBody, 4)}
  });\n`;
}

function generateFormDataServerFn(
  name: string,
  body: string,
  prefix: string,
): string {
  return `${prefix} ${name} = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) {
      throw new Error("Expected FormData");
    }
    return data;
  })
  .handler(async ({ data: formData }) => {
${indent(body, 4)}
  });\n`;
}

function generateParamsServerFn(
  name: string,
  params: string,
  body: string,
  prefix: string,
): string {
  // Parse params to create a type
  const paramNames = params
    .split(",")
    .map((p) => (p.trim().split(":")[0] ?? "").split("=")[0]?.trim() ?? "");
  const paramTypes = params.split(",").map((p) => {
    const parts = p.trim().split(":");
    return parts[1]?.trim() || "any";
  });

  // Create Zod-like validation or simple type validation
  const hasComplexTypes = paramTypes.some(
    (t) => t.includes("{") || t.includes("Array") || t.includes("|"),
  );

  if (hasComplexTypes) {
    return `${prefix} ${name} = createServerFn({ method: "POST" })
  .inputValidator((data: { ${params} }) => data)
  .handler(async ({ data }) => {
    const { ${paramNames.join(", ")} } = data;
${indent(body, 4)}
  });\n`;
  } else {
    return `${prefix} ${name} = createServerFn({ method: "POST" })
  .inputValidator((data: { ${params} }) => data)
  .handler(async ({ data }) => {
    const { ${paramNames.join(", ")} } = data;
${indent(body, 4)}
  });\n`;
  }
}

function indent(str: string, spaces: number): string {
  const indentStr = " ".repeat(spaces);
  return str
    .split("\n")
    .map((line) => (line.trim() ? indentStr + line : line))
    .join("\n");
}

function extractParamsText(func: any): string {
  const paramsNode = func.find({ rule: { kind: "formal_parameters" } });
  if (paramsNode) {
    return paramsNode
      .text()
      .replace(/^\(|\)$/g, "")
      .trim();
  }
  const fallback = func.getMultipleMatches?.("PARAMS");
  if (fallback && Array.isArray(fallback)) {
    return fallback
      .map((p: any) => p.text())
      .join(", ")
      .trim();
  }
  return "";
}

// Additional helper for handling inline server functions in Server Components
export const inlineServerFunctionTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  // Find Server Components (no "use client", has async server function with "use server")
  const hasUseClient = rootNode.find({
    rule: {
      any: [
        { pattern: `"use client";`, kind: "expression_statement" },
        { pattern: `'use client';`, kind: "expression_statement" },
      ],
    },
  });

  if (hasUseClient) return null;

  // Find inline server functions in Server Components
  const inlineServerFunctions = rootNode.findAll({
    rule: {
      pattern: `async function $NAME($$$PARAMS) { "use server"; $$$BODY }`,
      kind: "function_declaration",
    },
  });

  if (inlineServerFunctions.length === 0) return null;

  // Extract and move to separate file or transform to createServerFn
  const functionsToExtract: Array<{ name: string; code: string }> = [];

  for (const func of inlineServerFunctions) {
    const nameNode = func.getMatch("NAME");
    const paramsNode = func.getMultipleMatches("PARAMS");
    const bodyNode = func.getMultipleMatches("BODY");

    const name = nameNode?.text() || "serverFn";
    const params = paramsNode.map((p: any) => p.text()).join(", ");
    const body = bodyNode.map((b: any) => b.text()).join("\n");

    // Create extracted function
    const extractedCode = `export const ${name} = createServerFn({ method: "POST" })
  .handler(async ({ data }: { data: { ${params} } }) => {
${indent(body.replace(/"use server";?/g, ""), 4)}
  });`;

    functionsToExtract.push({ name, code: extractedCode });

    // Replace inline function with reference to extracted function
    // This requires importing the function from the new file
    edits.push(func.replace(`// Moved to ./${name}.server.ts`));
  }

  // Add import for the extracted functions
  if (functionsToExtract.length > 0) {
    const firstImport = rootNode.find({ rule: { kind: "import_statement" } });
    const importStatements = functionsToExtract
      .map((f) => `import { ${f.name} } from "./${f.name}.server";`)
      .join("\n");

    if (firstImport) {
      edits.push(
        firstImport.replace(`${importStatements}\n${firstImport.text()}`),
      );
    }
  }

  return edits.length > 0 ? edits : null;
};
