import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextUseClientDirectiveTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  const isTopLevel = (node: any) => node?.parent()?.kind?.() === "program";

  const useClientDirectives = rootNode
    .findAll({
      rule: {
        any: [
          { pattern: `"use client";`, kind: "expression_statement" },
          { pattern: `'use client';`, kind: "expression_statement" },
          { pattern: `"use client"`, kind: "expression_statement" },
          { pattern: `'use client'`, kind: "expression_statement" },
        ],
      },
    })
    .filter((node: any) => isTopLevel(node));

  if (useClientDirectives.length === 0) return null;

  for (const directive of useClientDirectives) {
    migrationMetric.increment({ bucket: "automated", effort: "low" });
    edits.push(directive.replace(""));
  }

  return edits.length > 0 ? edits : null;
};

