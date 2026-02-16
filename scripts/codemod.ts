import type { Edit, Transform } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import * as fsp from "fs/promises";
import { nextImageTransform } from "../transforms/next-image.ts";
import { nextLinkTransform } from "../transforms/next-link.ts";
import { nextServerFunctionTransform } from "../transforms/next-server-actions.ts";
import { nextUseClientDirectiveTransform } from "../transforms/next-use-client.ts";
import { nextApiRouteTransform } from "../transforms/api-routes.ts";
import { nextManualMigrationTodoTransform } from "../transforms/manual-migration-todos.ts";
import {
  nextToTanstackFileStructureTransform,
  nextRouteGroupsTransform,
} from "../transforms/route-renames.ts";

let hasLoggedDeleteWarning = false;
let hasLoggedConfigWarning = false;
const routesDirCache = new Map<string, Promise<string>>();
const projectConfigCache = new Map<string, Promise<CodemodProjectConfig>>();

const MIGRATION_IDS = [
  "next-image",
  "next-link",
  "next-server-functions",
  "manual-migration-todos",
  "next-use-client",
  "route-file-structure",
  "route-groups",
  "api-routes",
] as const;

type MigrationId = (typeof MIGRATION_IDS)[number];

type CodemodProjectConfig = {
  routesDirectory?: string;
  appDirectory?: string;
  enabledMigrations?: string[];
  disabledMigrations?: string[];
  migrations?: Record<string, boolean>;
};

type ResolvedRuntimeConfig = {
  routesDirectory: string;
  appDirectory: string;
  enabledMigrations: Set<MigrationId>;
};

function readCliOption(name: string): string | null {
  const exact = `--${name}`;
  const withEq = `${exact}=`;

  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg) continue;
    if (arg === exact) {
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) return next;
      return null;
    }
    if (arg.startsWith(withEq)) {
      return arg.slice(withEq.length);
    }
  }

  return null;
}

function normalizeRoutesDirectory(value: string): string {
  return value
    .trim()
    .replace(/^[./\\]+/, "")
    .replace(/[\\/]+$/, "");
}

function normalizeAppDirectory(value: string): string {
  return value
    .trim()
    .replace(/^[./\\]+/, "")
    .replace(/[\\/]+$/, "");
}

function normalizeDirSegments(value: string): string[] {
  return normalizePath(value).split("/").filter(Boolean);
}

function findSubPathIndex(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matches = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function normalizeMigrationId(value: string): MigrationId | null {
  if ((MIGRATION_IDS as readonly string[]).includes(value))
    return value as MigrationId;
  return null;
}

function getRoutesDirectoryOverride(): string | null {
  const cliValue = readCliOption("routes-directory");
  if (cliValue) {
    const normalized = normalizeRoutesDirectory(cliValue);
    if (normalized) return normalized;
  }

  const envValue =
    process.env.CODEMOD_ROUTES_DIRECTORY ?? process.env.ROUTES_DIRECTORY;
  if (envValue) {
    const normalized = normalizeRoutesDirectory(envValue);
    if (normalized) return normalized;
  }

  return null;
}

function getRoutesDirectoryOverrideFromOptions(
  options: unknown,
): string | null {
  if (!options || typeof options !== "object") return null;
  const params = (options as { params?: Record<string, unknown> }).params;
  if (!params || typeof params !== "object") return null;

  const candidateKeys = [
    "routesDirectory",
    "routes_directory",
    "routes-dir",
    "routesDir",
  ];
  for (const key of candidateKeys) {
    const raw = params[key];
    if (typeof raw !== "string") continue;
    const normalized = normalizeRoutesDirectory(raw);
    if (normalized) return normalized;
  }
  return null;
}

function isDryRun(): boolean {
  return (
    process.argv.includes("--dry-run") ||
    process.env.CODEMOD_DRY_RUN === "1" ||
    process.env.DRY_RUN === "1"
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function dirname(value: string): string {
  const normalized = normalizePath(value);
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "." : normalized.slice(0, idx);
}

function mapRouteSegment(segment: string): string {
  const groupMatch = segment.match(/^\(([^)]+)\)$/);
  if (groupMatch?.[1]) return `_${groupMatch[1]}`;

  const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
  if (optionalCatchAllMatch) return "$";

  const catchAllMatch = segment.match(/^\[\.\.\.([^\]]+)\]$/);
  if (catchAllMatch) return "$";

  const dynamicMatch = segment.match(/^\[([^\]]+)\]$/);
  if (dynamicMatch?.[1]) return `$${dynamicMatch[1]}`;

  return segment;
}

function mapRouteFilename(base: string, isRootLayout: boolean): string | null {
  if (/^page\.(tsx|jsx|ts|js)$/.test(base))
    return base.replace(/^page\./, "index.");
  if (/^layout\.(tsx|jsx|ts|js)$/.test(base)) {
    return base.replace(/^layout\./, isRootLayout ? "__root." : "_layout.");
  }
  if (/^loading\.(tsx|jsx|ts|js)$/.test(base))
    return base.replace(/^loading\./, "-pending.");
  if (/^error\.(tsx|jsx|ts|js)$/.test(base))
    return base.replace(/^error\./, "-error.");
  if (/^not-found\.(tsx|jsx|ts|js)$/.test(base)) {
    return base.replace(/^not-found\./, "-not-found.");
  }
  if (/^template\.(tsx|jsx|ts|js)$/.test(base))
    return base.replace(/^template\./, "-template.");
  if (/^default\.(tsx|jsx|ts|js)$/.test(base))
    return base.replace(/^default\./, "-default.");
  if (/^route\.(tsx|jsx|ts|js)$/.test(base)) return base;
  return null;
}

async function readTextFile(path: string): Promise<string | null> {
  const readFn = (
    fsp as unknown as { readFile?: (p: string, e: string) => Promise<string> }
  ).readFile;
  if (typeof readFn !== "function") return null;
  try {
    return await readFn(path, "utf8");
  } catch {
    return null;
  }
}

function parseProjectConfigJson(source: string): CodemodProjectConfig | null {
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as CodemodProjectConfig;
  } catch {
    return null;
  }
}

async function readProjectConfig(
  filename: string,
): Promise<CodemodProjectConfig> {
  const normalizedFilename = normalizePath(filename);
  const cacheKey = dirname(normalizedFilename);
  const existing = projectConfigCache.get(cacheKey);
  if (existing) return existing;

  const loader = (async () => {
    const configFile = await findNearestFile(cacheKey, [
      "next-to-start.codemod.json",
      ".next-to-start.codemod.json",
      "next-to-start.codemodrc.json",
    ]);
    if (!configFile) return {};

    const source = await readTextFile(configFile);
    if (!source) return {};

    const parsed = parseProjectConfigJson(source);
    if (!parsed) {
      if (!hasLoggedConfigWarning) {
        hasLoggedConfigWarning = true;
        console.warn(
          `[route-rename] Invalid JSON config at ${configFile}; ignoring.`,
        );
      }
      return {};
    }
    return parsed;
  })();

  projectConfigCache.set(cacheKey, loader);
  return loader;
}

async function findNearestFile(
  startDir: string,
  candidates: string[],
): Promise<string | null> {
  let currentDir = normalizePath(startDir);
  while (true) {
    for (const candidate of candidates) {
      const filePath = `${trimTrailingSlash(currentDir)}/${candidate}`;
      if (await existsFile(filePath)) return filePath;
    }
    const parent = dirname(currentDir);
    if (!parent || parent === "." || parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

function parseRoutesDirectoryFromViteConfig(source: string): string | null {
  const match = source.match(/routesDirectory\s*:\s*['"`]([^'"`]+)['"`]/);
  return match?.[1]?.trim() || null;
}

function resolveEnabledMigrations(
  config: CodemodProjectConfig,
): Set<MigrationId> {
  const enabled = new Set<MigrationId>(MIGRATION_IDS);

  if (
    Array.isArray(config.enabledMigrations) &&
    config.enabledMigrations.length > 0
  ) {
    enabled.clear();
    for (const raw of config.enabledMigrations) {
      if (typeof raw !== "string") continue;
      const id = normalizeMigrationId(raw);
      if (id) enabled.add(id);
    }
  }

  if (Array.isArray(config.disabledMigrations)) {
    for (const raw of config.disabledMigrations) {
      if (typeof raw !== "string") continue;
      const id = normalizeMigrationId(raw);
      if (id) enabled.delete(id);
    }
  }

  if (config.migrations && typeof config.migrations === "object") {
    for (const [rawKey, rawValue] of Object.entries(config.migrations)) {
      const id = normalizeMigrationId(rawKey);
      if (!id || typeof rawValue !== "boolean") continue;
      if (rawValue) enabled.add(id);
      else enabled.delete(id);
    }
  }

  return enabled;
}

async function getConfiguredRoutesDirectory(
  filename: string,
  projectConfig: CodemodProjectConfig,
  override?: string | null,
): Promise<string> {
  const configOverride =
    (typeof projectConfig.routesDirectory === "string" &&
      normalizeRoutesDirectory(projectConfig.routesDirectory)) ||
    null;
  if (configOverride) return configOverride;

  const resolvedOverride = override || getRoutesDirectoryOverride();
  if (resolvedOverride) return normalizeRoutesDirectory(resolvedOverride);

  const normalizedFilename = normalizePath(filename);
  const appDir =
    (typeof projectConfig.appDirectory === "string" &&
      normalizeAppDirectory(projectConfig.appDirectory)) ||
    "app";
  const appMarker = normalizedFilename.lastIndexOf(`/${appDir}/`);
  if (appMarker === -1) return "routes";
  const projectRootGuess = normalizedFilename.slice(0, appMarker) || ".";
  const cacheKey = normalizePath(projectRootGuess);
  const existing = routesDirCache.get(cacheKey);
  if (existing) return existing;

  const loader = (async () => {
    const configFile = await findNearestFile(projectRootGuess, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.cts",
      "vite.config.mjs",
      "vite.config.cjs",
    ]);
    if (!configFile) return "routes";

    const source = await readTextFile(configFile);
    if (!source) {
      if (!hasLoggedConfigWarning) {
        hasLoggedConfigWarning = true;
        console.warn(
          "[route-rename] Could not read vite config; defaulting routesDirectory to 'routes'.",
        );
      }
      return "routes";
    }

    return normalizeRoutesDirectory(
      parseRoutesDirectoryFromViteConfig(source) || "routes",
    );
  })();

  routesDirCache.set(cacheKey, loader);
  return loader;
}

async function resolveRuntimeConfig(
  filename: string,
  options?: unknown,
): Promise<ResolvedRuntimeConfig> {
  const projectConfig = await readProjectConfig(filename);
  const optionsOverride = getRoutesDirectoryOverrideFromOptions(options);
  const routesDirectory = await getConfiguredRoutesDirectory(
    filename,
    projectConfig,
    optionsOverride,
  );
  const appDirectory =
    normalizeAppDirectory(projectConfig.appDirectory || "app") || "app";
  const enabledMigrations = resolveEnabledMigrations(projectConfig);
  return { routesDirectory, appDirectory, enabledMigrations };
}

async function computeTanstackTargetPath(
  filename: string,
  runtimeConfig: ResolvedRuntimeConfig,
): Promise<string | null> {
  if (!/\.(tsx|jsx|ts|js)$/.test(filename)) return null;
  if (filename.includes("node_modules")) return null;

  const sep = filename.includes("\\") ? "\\" : "/";
  const segments = filename.split(/[/\\]/);
  if (segments.length < 2) return null;

  const appDirSegments = normalizeDirSegments(runtimeConfig.appDirectory);
  const appIndex = findSubPathIndex(segments, appDirSegments);
  if (appIndex === -1) return null;
  const appEndIndex = appIndex + appDirSegments.length;
  if (appEndIndex >= segments.length) return null;

  const fileBase = segments[segments.length - 1];
  if (!fileBase) return null;
  const relativeRouteSegments = segments.slice(appEndIndex, -1);
  const hasPrivateSegment = relativeRouteSegments.some((segment) =>
    /^_[^/\\]+$/.test(segment),
  );
  const hasParallelSegment = relativeRouteSegments.some((segment) =>
    /^@[^/\\]+$/.test(segment),
  );
  const hasRouteGroupSegment = relativeRouteSegments.some((segment) =>
    /^\([^)]+\)$/.test(segment),
  );
  const isGroupOnlyBranch =
    relativeRouteSegments.length > 0 &&
    relativeRouteSegments.every((segment) => /^\([^)]+\)$/.test(segment));
  const isLayoutLikeFile = /^(layout|template)\.(tsx|jsx|ts|js)$/.test(fileBase);

  // Next.js private folders (_foo), parallel routes (@slot), and layout/template
  // inside route-group segments need manual handling to avoid invalid/conflicting routes.
  if (hasPrivateSegment || hasParallelSegment) return null;
  if (hasRouteGroupSegment && isLayoutLikeFile && !isGroupOnlyBranch)
    return null;

  const isRootLayout =
    relativeRouteSegments.length === 0 &&
    /^layout\.(tsx|jsx|ts|js)$/.test(fileBase);
  const mappedBase = mapRouteFilename(fileBase, isRootLayout);
  if (!mappedBase) return null;

  const routesDirectory = runtimeConfig.routesDirectory;
  const routesDirSegments = routesDirectory.split(/[/\\]/).filter(Boolean);
  if (routesDirSegments.length === 0) return null;

  const mappedDirs = relativeRouteSegments.map(mapRouteSegment);
  const targetSegments = [
    ...segments.slice(0, appIndex),
    ...routesDirSegments,
    ...mappedDirs,
    mappedBase,
  ];
  const targetPath = targetSegments.join(sep);

  if (normalizePath(targetPath) === normalizePath(filename)) return null;
  return targetPath;
}

function computeExpectedRoutePathFromSourcePath(
  filename: string,
  runtimeConfig: ResolvedRuntimeConfig,
): string | null {
  const normalized = normalizePath(filename);
  const segments = normalized.split("/").filter(Boolean);
  const appDirSegments = normalizeDirSegments(runtimeConfig.appDirectory);
  const appIndex = findSubPathIndex(segments, appDirSegments);
  if (appIndex === -1) return null;

  const appEndIndex = appIndex + appDirSegments.length;
  const relativeSegments = segments.slice(appEndIndex);
  if (relativeSegments.length === 0) return null;
  if (relativeSegments[0] === "api") return null;

  const withoutFilename = relativeSegments.slice(0, -1);
  const filenamePart = relativeSegments[relativeSegments.length - 1] ?? "";
  const strippedFilename = filenamePart.replace(
    /^(page|layout|loading|error|not-found|template|route)\.(tsx|jsx|ts|js)$/,
    "",
  );

  let routePath = [...withoutFilename, strippedFilename]
    .filter(Boolean)
    .join("/")
    .replace(/\/$/, "");

  routePath = routePath.replace(/\(([^)]+)\)/g, "_$1");
  routePath = routePath.replace(/\[\[\.\.\.[^\]]+\]\]/g, "$");
  routePath = routePath.replace(/\[\.\.\.[^\]]+\]/g, "$");
  routePath = routePath.replace(
    /\[([^\]]+)\]/g,
    (_match, paramName: string) => `$${paramName}`,
  );

  if (!routePath.startsWith("/")) routePath = `/${routePath}`;
  routePath = routePath.replace(/\/$/, "");
  return routePath || "/";
}

function isRootRouteTarget(path: string): boolean {
  return /\/__root\.(tsx|jsx|ts|js)$/.test(normalizePath(path));
}

function normalizeRootRouteSource(source: string): string {
  let next = source;

  // Convert factory call: createFileRoute('/')({ ... }) -> createRootRoute({ ... })
  next = next.replace(
    /createFileRoute\(\s*(['"`])\/\1\s*\)\s*\(/g,
    "createRootRoute(",
  );

  // Update tanstack import binding.
  next = next.replace(
    /import\s*{\s*([^}]+)\s*}\s*from\s*(['"])@tanstack\/react-router\2/g,
    (_full, imports: string, quote: string) => {
      const parts = imports
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

      const withoutCreateFileRoute = parts.filter(
        (part) => part !== "createFileRoute",
      );
      const withCreateRootRoute = withoutCreateFileRoute.includes(
        "createRootRoute",
      )
        ? withoutCreateFileRoute
        : ["createRootRoute", ...withoutCreateFileRoute];

      return `import { ${withCreateRootRoute.join(", ")} } from ${quote}@tanstack/react-router${quote}`;
    },
  );

  return next;
}

function assertCreateFileRoutePathMatch(
  oldPath: string,
  newPath: string,
  source: string,
  runtimeConfig: ResolvedRuntimeConfig,
): void {
  if (isRootRouteTarget(newPath)) {
    if (!/createRootRoute\s*\(/.test(source)) {
      throw new Error(
        [
          "Root route mismatch for moved file.",
          `source: ${oldPath}`,
          `target: ${newPath}`,
          "expected root route to use createRootRoute(...) in __root.tsx",
        ].join("\n"),
      );
    }
    return;
  }

  const expected = computeExpectedRoutePathFromSourcePath(
    oldPath,
    runtimeConfig,
  );
  if (!expected) return;
  if (/createRootRoute\s*\(/.test(source)) return;

  const match = source.match(/createFileRoute\((['"`])([^'"`]+)\1\)/);
  if (!match?.[2]) return;
  const actual = match[2];

  if (actual !== expected) {
    throw new Error(
      [
        "Route path mismatch for moved file.",
        `source: ${oldPath}`,
        `expected createFileRoute: ${expected}`,
        `actual createFileRoute: ${actual}`,
      ].join("\n"),
    );
  }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

async function tryDeleteFile(path: string): Promise<void> {
  const rmFn = (fsp as unknown as { rm?: (p: string) => Promise<void> }).rm;
  const unlinkFn = (fsp as unknown as { unlink?: (p: string) => Promise<void> })
    .unlink;

  if (typeof unlinkFn === "function") {
    await unlinkFn(path);
    return;
  }
  if (typeof rmFn === "function") {
    await rmFn(path);
    return;
  }

  if (!hasLoggedDeleteWarning) {
    hasLoggedDeleteWarning = true;
    console.warn(
      "[route-rename] Delete API unavailable in this runtime; keeping original files in app/.",
    );
  }
}

async function writeMovedFileAndDeleteOriginal(
  oldPath: string,
  newPath: string,
  output: string,
  appDirectory: string,
): Promise<void> {
  if (normalizePath(oldPath) === normalizePath(newPath)) return;

  if (await existsFile(newPath)) {
    const readFn = (
      fsp as unknown as { readFile?: (p: string, e: string) => Promise<string> }
    ).readFile;
    if (typeof readFn === "function") {
      const existing = await readFn(newPath, "utf8");
      if (existing === output) {
        if (await existsFile(oldPath)) {
          await tryDeleteFile(oldPath);
          await pruneEmptyRouteDirs(oldPath, appDirectory);
        }
        return;
      }
    }
    throw new Error(
      `Refusing to overwrite existing target file with different content: ${newPath}`,
    );
  }

  await fsp.mkdir(dirname(newPath), { recursive: true });
  await fsp.writeFile(newPath, output, "utf8");
  if (await existsFile(oldPath)) {
    await tryDeleteFile(oldPath);
    await pruneEmptyRouteDirs(oldPath, appDirectory);
  }
}

async function pruneEmptyRouteDirs(
  movedFromFilePath: string,
  appDirectory: string,
): Promise<void> {
  const normalizedFilePath = normalizePath(movedFromFilePath);
  const segments = normalizedFilePath.split("/").filter(Boolean);
  const appSegments = normalizeDirSegments(appDirectory);
  const appIndex = findSubPathIndex(segments, appSegments);
  if (appIndex === -1) return;

  const appPath = segments.slice(0, appIndex + appSegments.length).join("/");
  let currentDir = dirname(normalizedFilePath);

  while (
    currentDir &&
    currentDir !== "." &&
    currentDir !== appPath &&
    currentDir.startsWith(`${appPath}/`)
  ) {
    if (!(await tryDeleteDirIfEmpty(currentDir))) break;
    currentDir = dirname(currentDir);
  }
}

async function tryDeleteDirIfEmpty(path: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(path);
    if (entries.length > 0) return false;
    await fsp.rm(path, { recursive: false, force: false });
    return true;
  } catch {
    return false;
  }
}

const transform: Transform<TSX> = async (root, options?: unknown) => {
  const rootNode = root.root();
  const allEdits: Edit[] = [];
  const runtimeConfig = await resolveRuntimeConfig(root.filename(), options);
  const enabled = runtimeConfig.enabledMigrations;

  const tasks: Array<Promise<Edit[] | null | undefined>> = [];
  if (enabled.has("next-image")) tasks.push(nextImageTransform(root));
  if (enabled.has("next-link")) tasks.push(nextLinkTransform(root));
  if (enabled.has("next-server-functions"))
    tasks.push(nextServerFunctionTransform(root));
  if (enabled.has("manual-migration-todos"))
    tasks.push(nextManualMigrationTodoTransform(root));
  if (enabled.has("next-use-client"))
    tasks.push(nextUseClientDirectiveTransform(root));
  if (enabled.has("route-file-structure"))
    tasks.push(nextToTanstackFileStructureTransform(root));
  if (enabled.has("route-groups")) tasks.push(nextRouteGroupsTransform(root));
  if (enabled.has("api-routes")) tasks.push(nextApiRouteTransform(root));

  const results = await Promise.all(tasks);

  for (const edits of results) {
    if (edits) {
      allEdits.push(...edits);
    }
  }

  const commitResult = rootNode.commitEdits(allEdits);
  const currentFilename = root.filename();
  const targetPath = enabled.has("route-file-structure")
    ? await computeTanstackTargetPath(currentFilename, runtimeConfig)
    : null;
  if (!isDryRun() && targetPath) {
    const output = isRootRouteTarget(targetPath)
      ? normalizeRootRouteSource(commitResult)
      : commitResult;
    assertCreateFileRoutePathMatch(
      currentFilename,
      targetPath,
      output,
      runtimeConfig,
    );
    await writeMovedFileAndDeleteOriginal(
      currentFilename,
      targetPath,
      output,
      runtimeConfig.appDirectory,
    );
    return null;
  }

  return commitResult;
};

export default transform;
