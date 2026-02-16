import type { Edit } from "codemod:ast-grep";
import type { SubTranform } from "../types/index.js";
import { useMetricAtom } from "codemod:metrics";

const migrationMetric = useMetricAtom("migration-impact");

export const nextImageTransform: SubTranform = async (root) => {
  const rootNode = root.root();
  const edits: Edit[] = [];

  if (
    root.filename().match(/(route|middleware|instrumentation|proxy)\.(ts|js)/)
  ) {
    return null;
  }

  const importNodes = rootNode.findAll({
    rule: {
      any: [
        { pattern: `import Image from "next/image"` },
        { pattern: `import Image from 'next/image'` },
      ],
      kind: "import_statement",
    },
  });

  if (!importNodes) return null;

  for (const node of importNodes) {
    edits.push(node.replace(`import { Image } from "@unpic/react";`));
  }

  const imgElements = rootNode.findAll({
    rule: {
      any: [
        { pattern: "<Image $$$PROPS />", kind: "jsx_self_closing_element" },
        { pattern: "<Image $$$PROPS>$$$CHILDREN</Image>", kind: "jsx_element" },
      ],
    },
  });

  for (const imgNode of imgElements) {
    const propNodes = imgNode.getMultipleMatches("PROPS");

    const newProps: string[] = [];
    let hasFill = false;
    let hasExplicitLayout = false;
    let hasWidth = false;
    let hasHeight = false;
    let isPlaceholderBlur = false;
    let blurDataURLValue = "";
    let hasPriority = false;

    for (const propNode of propNodes) {
      const nameNode = propNode.child(0);
      if (!nameNode) continue;

      const propName = nameNode.text();

      const initializerNode = propNode.child(2);
      const propValueText = initializerNode ? initializerNode.text() : "";

      if (propName === "fill") {
        hasFill = true;
        continue; // Remove 'fill'
      }

      if (propName === "layout") {
        hasExplicitLayout = true;
        // Handle legacy layout="fill"
        if (
          propValueText.includes('"fill"') ||
          propValueText.includes("'fill'")
        ) {
          hasFill = true;
          hasExplicitLayout = false; // replace it with our own layout="fullWidth"
          continue; // Remove legacy prop
        }
        // Keep other layouts (fixed, responsive, etc.)
        newProps.push(propNode.text());
        continue;
      }

      if (propName === "width") hasWidth = true;
      if (propName === "height") hasHeight = true;

      if (propName === "priority") hasPriority = true;

      if (propName === "placeholder") {
        if (
          propValueText.includes('"blur"') ||
          propValueText.includes("'blur'")
        ) {
          isPlaceholderBlur = true;
        }
        continue; // Remove placeholder prop
      }

      if (propName === "blurDataURL") {
        // Extract exact value content (remove the leading '=')
        if (initializerNode) {
          blurDataURLValue = propValueText.substring(1);
        }
        continue; // Remove blurDataURL prop
      }

      if (propName === "loading") {
        if (
          propValueText.includes('"eager"') ||
          propValueText.includes("'eager'")
        ) {
          if (!hasPriority) {
            newProps.push("priority");
            hasPriority = true;
          }
        }
        continue; // Remove loading prop (Unpic handles this)
      }

      if (propName === "onLoadingComplete") {
        if (initializerNode) {
          const val = propValueText.substring(1);
          newProps.push(`onLoad={${val}}`);
        }
        continue;
      }

      // Props to Remove entirely
      if (
        [
          "quality",
          "unoptimized",
          "loader",
          "loaderFile",
          "objectFit",
          "preload",
        ].includes(propName)
      ) {
        continue;
      }

      newProps.push(propNode.text());
    }

    // Handle Layout
    if (hasFill) {
      newProps.push('layout="fullWidth"');
    } else if (hasWidth && hasHeight && !hasExplicitLayout) {
      // Only add constrained if no other layout is specified
      newProps.push('layout="constrained"');
    }

    // Handle Background (Placeholder replacement)
    if (isPlaceholderBlur) {
      if (blurDataURLValue) {
        newProps.push(`background=${blurDataURLValue}`);
      } else {
        newProps.push('background="auto"');
      }
    }

    const propsString = newProps.join(" ");

    // Check if self-closing or has children
    const isSelfClosing = imgNode.kind() === "jsx_self_closing_element";

    migrationMetric.increment({ bucket: "automated", effort: "low" });
    if (isSelfClosing) {
      edits.push(imgNode.replace(`<Image ${propsString} />`));
    } else {
      const childrenMatches = imgNode.getMultipleMatches("CHILDREN");
      const children = childrenMatches.map((c) => c.text()).join("");
      edits.push(imgNode.replace(`<Image ${propsString}>${children}</Image>`));
    }
  }

  return edits;
};
