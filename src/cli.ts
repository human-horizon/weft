#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename, extname, relative, join } from "node:path";
import { createRequire } from "node:module";
import { env, argv, exit, cwd, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);

// ── Colours ─────────────────────────────────────────────────────────────────

const isColour = env.FORCE_COLOR || (env.TERM && env.TERM !== "dumb");

const c = (code: string, text: string) =>
    isColour ? `\x1b[${code}m${text}\x1b[0m` : text;

const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const yellow = (s: string) => c("33", s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const cyan = (s: string) => c("36", s);

// ── Resolve pi from weft's own node_modules ────────────────────────────────

let piPath: string;
try {
    piPath = require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
} catch {
    piPath = "pi";
}

// ── Config ──────────────────────────────────────────────────────────────────

const PIPELINES_DIR = env.WEFT_PIPELINES_DIR || "./pipelines";
const WEFT_PI_HOME = env.WEFT_PI_HOME || join(homedir(), ".ai", "weft", "pi");

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = argv.slice(2);
    const command = args[0] || "interactive";

    switch (command) {
        case "run":
            return cmdRun(args.slice(1));
        case "list":
        case "ls":
            return cmdList(args[1]);
        case "init":
            return cmdInit(args[1]);
        case "install":
            return cmdInstall();
        case "interactive":
            return cmdInteractive();
        case "help":
        case "--help":
        case "-h":
            return cmdHelp(args[1] as keyof typeof HELP | undefined);
        default:
            console.error(red(`❌ Unknown command: ${command}`));
            cmdHelp();
            exit(1);
    }
}

// ── Help text ───────────────────────────────────────────────────────────────

const HELP = {
    main: `
${bold("weft")} ${dim("— TypeScript-native workflow engine for AI agents")}

${bold("Usage:")}
  weft ${green("run")} ${dim("<file> [args...]")}    Run a pipeline
  weft ${green("list")} ${dim("[dir]")}              List pipelines
  weft ${green("init")} ${dim("<name>")}             Create a new pipeline
  weft ${green("install")}                          Setup project: .lore/weft/ + pnpm install
  weft ${green("help")} ${dim("[command]")}           Show help

${bold("Interactive:")}
  weft                                  Select and run a pipeline interactively

${bold("Examples:")}
  weft run pipeline.ts "my topic"
  weft run ./.lore/weft/pipelines/my-pipeline.ts
  weft list
  weft init my-pipeline
  weft install

${dim("Environment:")}
  WEFT_PIPELINES_DIR    Pipeline directory (default: ./pipelines)
  WEFT_PI_PATH          Path to pi CLI
`,
    run: `
${bold("weft run")} ${dim("<file> [args...]")}

Run a TypeScript pipeline file.

${bold("Arguments:")}
  ${dim("<file>")}       Path to .ts file (searched in CWD and WEFT_PIPELINES_DIR)
  ${dim("[args...]")}    Arguments passed to the pipeline

${bold("Flags:")}
  ${dim("--dry-run")}    Show what would run without executing

${bold("Examples:")}
  weft run pipeline.ts "topic"
  weft run ИсправьСтатью.ts ./article.json
  weft run ./.lore/weft/pipelines/НапишиСтатью.ts "Тревога" --dry-run
`,
    list: `
${bold("weft list")} ${dim("[dir]")}

List available pipeline files.

${bold("Arguments:")}
  ${dim("[dir]")}    Directory to scan (default: WEFT_PIPELINES_DIR or .lore/weft/pipelines)
`,
    init: `
${bold("weft init")} ${dim("<name>")}

Create a new pipeline from template.

${bold("Arguments:")}
  ${dim("<name>")}    Pipeline name (without .ts)
`,
    install: `
${bold("weft install")}

Setup weft in the current project:
  - Creates ${dim(".lore/weft/pipelines/")} folder for your pipeline files
  - Creates ${dim(".lore/weft/package.json")} with weft dependency (if missing)
  - Creates ${dim(".lore/weft/.gitignore")} (if missing)
  - Runs ${dim("pnpm install")} in ${dim(".lore/weft/")}

${bold("Examples:")}
  cd my-project && weft install
`,
};

// ── Commands ────────────────────────────────────────────────────────────────

function cmdHelp(topic?: keyof typeof HELP) {
    if (topic && HELP[topic]) {
        console.log(HELP[topic]);
        return;
    }
    console.log(HELP.main);
}

function cmdRun(runArgs: string[]) {
    const fileArg = runArgs[0];
    if (!fileArg || fileArg === "--help" || fileArg === "-h") {
        console.log(HELP.run);
        exit(fileArg ? 0 : 1);
    }

    // Resolve file path
    let filePath = resolve(cwd(), fileArg);
    if (!existsSync(filePath)) {
        // Try in pipelines dir
        const inPipelines = resolve(cwd(), PIPELINES_DIR, fileArg);
        if (existsSync(inPipelines)) {
            filePath = inPipelines;
        } else {
            // Try with .ts extension
            const withExt = filePath.endsWith(".ts") ? filePath : `${filePath}.ts`;
            if (existsSync(withExt)) {
                filePath = withExt;
            } else {
                const inPipelinesWithExt = inPipelines.endsWith(".ts")
                    ? inPipelines
                    : `${inPipelines}.ts`;
                if (existsSync(inPipelinesWithExt)) {
                    filePath = inPipelinesWithExt;
                } else {
                    console.error(red(`❌ File not found: ${fileArg}`));
                    console.error(
                        dim(`  Searched:\n    ${filePath}\n    ${inPipelines}`),
                    );
                    exit(1);
                }
            }
        }
    }

    const extraArgs = runArgs.slice(1);
    const dryRun = extraArgs.includes("--dry-run");
    if (dryRun) {
        extraArgs.splice(extraArgs.indexOf("--dry-run"), 1);
    }

    const runtime = detectRuntime(filePath);
    if (!runtime) {
        console.error(
            red(
                "❌ No TypeScript runtime found. Install bun, tsx, or ts-node.",
            ),
        );
        exit(1);
    }

    console.log(
        `${dim("⚡ weft run")} ${cyan(filePath)} ${dim(extraArgs.join(" ") || "")}`,
    );
    console.log(`${dim(`  runtime: ${runtime}`)}`);

    if (dryRun) {
        console.log(dim(`  (dry run — not executing)`));
        return;
    }

    const child = spawn(runtime, [filePath, ...extraArgs], {
        stdio: "inherit",
        env: {
            ...env,
            WEFT_PI_PATH: piPath,
            PI_CODING_AGENT_DIR: WEFT_PI_HOME,
        },
    });

    child.on("exit", (code) => exit(code ?? 0));
    child.on("error", (err) => {
        console.error(red(`❌ Failed to start: ${err.message}`));
        exit(1);
    });
}

function cmdList(dirArg?: string) {
    const dir = dirArg
        ? resolve(cwd(), dirArg)
        : resolve(cwd(), PIPELINES_DIR);

    if (!existsSync(dir)) {
        console.error(
            yellow(`⚠  Directory not found: ${dir}`),
        );
        console.error(dim(`  Set WEFT_PIPELINES_DIR or pass a path.`));
        exit(1);
    }

    const files = findTsFilesRecursive(dir)
        .sort();

    if (files.length === 0) {
        console.log(yellow(`No pipelines found in ${dir}`));
        return;
    }

    const rel = relative(cwd(), dir);
    console.log(`${bold(`Pipelines`)} ${dim(`in ${rel}`)}`);
    console.log();

    for (const file of files) {
        const name = basename(file, ".ts");
        const meta = extractMeta(resolve(dir, file));
        const desc = meta?.description ? dim(meta.description) : "";
        const sub = dirname(file) !== "." ? dim(`[${dirname(file)}]`) : "";
        console.log(`  ${cyan(name)} ${desc} ${sub}`);
    }
    console.log();
    console.log(dim(`  ${files.length} pipeline(s)`));
}

function cmdInit(name?: string) {
    if (!name) {
        console.error(red("❌ Usage: weft init <name>"));
        exit(1);
    }

    const dir = resolve(cwd(), PIPELINES_DIR);
    mkdirSync(dir, { recursive: true });

    const filePath = resolve(dir, `${name}.ts`);

    if (existsSync(filePath)) {
        console.error(red(`❌ File already exists: ${filePath}`));
        exit(1);
    }

    const template = `import { weave } from "@human-horizon/weft";
import { z } from "zod";

// ── Meta ────────────────────────────────────────────────────────────────────

export const meta = {
    description: "Describe what this pipeline does",
    args: [
        { name: "input", type: "string", description: "Input text to process", default: "" },
    ],
};

// ── Schema ─────────────────────────────────────────────────────────────────

const ResultSchema = z.object({
    result: z.string(),
});

// ── Pipeline ────────────────────────────────────────────────────────────────

const pipeline = weave<{ input: string }>()
    .prompt(
        "result",
        (ctx) => \`Process: \${ctx.input}\`,
        { schema: ResultSchema, model: "medium" },
    )
    .build();

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(args: string[]) {
    const input = args[0] || "";
    if (!input) {
        console.error("❌ Usage: weft run ${name}.ts <input>");
        process.exit(1);
    }

    const output = await pipeline.run({ input });
    console.log(JSON.stringify(output, null, 2));
}

await main(process.argv.slice(2));
`;

    writeFileSync(filePath, template, "utf-8");
    console.log(green(`✓ Created ${filePath}`));
}

// ── Install command ──────────────────────────────────────────────────────────

function cmdInstall() {
    const projectDir = cwd();

    // 1. Create .lore/weft/ directory
    const loreDir = resolve(projectDir, ".lore", "weft");
    if (!existsSync(loreDir)) {
        mkdirSync(loreDir, { recursive: true });
        console.log(green(`✓ Created ${relative(projectDir, loreDir)}/`));
    } else {
        console.log(dim(`  ${relative(projectDir, loreDir)}/ already exists`));
    }

    // 2. Create .lore/weft/pipelines/ directory
    const pipelinesDir = resolve(loreDir, "pipelines");
    if (!existsSync(pipelinesDir)) {
        mkdirSync(pipelinesDir, { recursive: true });
        console.log(green(`✓ Created ${relative(projectDir, pipelinesDir)}/`));
    } else {
        console.log(dim(`  ${relative(projectDir, pipelinesDir)}/ already exists`));
    }

    // 3. Create .lore/weft/package.json
    const lorePkgPath = resolve(loreDir, "package.json");
    if (!existsSync(lorePkgPath)) {
        const pkg = {
            name: `${basename(projectDir)}-weft`,
            private: true,
            type: "module",
            dependencies: {
                "@human-horizon/weft": "^0.1.0",
            },
            devDependencies: {
                "@types/node": "^22.0.0",
                tsx: "^4.19.0",
                typescript: "^5.7.0",
            },
        };
        writeFileSync(lorePkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
        console.log(green(`✓ Created ${relative(projectDir, lorePkgPath)}`));
    } else {
        console.log(dim(`  ${relative(projectDir, lorePkgPath)} already exists`));
    }

    // 4. Create .lore/weft/.gitignore
    const loreGitignorePath = resolve(loreDir, ".gitignore");
    if (!existsSync(loreGitignorePath)) {
        const gitignore = "node_modules\npnpm-lock.yaml\n";
        writeFileSync(loreGitignorePath, gitignore, "utf-8");
        console.log(green(`✓ Created ${relative(projectDir, loreGitignorePath)}`));
    } else {
        console.log(dim(`  ${relative(projectDir, loreGitignorePath)} already exists`));
    }

    // 5. Run pnpm install in .lore/weft/
    console.log(dim(`\n📦 Running pnpm install in .lore/weft/...`));
    try {
        execSync("CI=true pnpm install", {
            stdio: "inherit",
            cwd: loreDir,
        });
        console.log(green(`\n✓ Done! Run ${cyan("weft")} to interactively select a pipeline.`));
    } catch (err) {
        console.error(red(`\n❌ pnpm install failed`));
        console.error(dim(`  Make sure pnpm is installed: npm install -g pnpm`));
        exit(1);
    }
}

// ── Interactive mode ────────────────────────────────────────────────────────

interface ArgMeta {
    name: string;
    type?: string;
    description?: string;
    default?: unknown;
}

interface PipelineMeta {
    description?: string;
    args?: ArgMeta[];
}

async function cmdInteractive() {
    // Determine directory: use CWD if it has .ts files, otherwise PIPELINES_DIR
    const cwdFiles = readdirSync(cwd()).filter((f) => f.endsWith(".ts"));
    const dir = cwdFiles.length > 0
        ? cwd()
        : resolve(cwd(), PIPELINES_DIR);

    if (!existsSync(dir)) {
        console.error(yellow(`⚠  Directory not found: ${dir}`));
        console.error(dim(`  Set WEFT_PIPELINES_DIR or run from a directory with .ts files.`));
        exit(1);
    }

    const files = findTsFilesRecursive(dir);

    if (files.length === 0) {
        console.error(yellow(`⚠  No pipelines found in ${relative(cwd(), dir)}`));
        exit(1);
    }

    // Show menu
    console.log(`\n${bold("Available pipelines:")} ${dim(`in ${relative(cwd(), dir)}`)}`);
    console.log();

    for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const meta = extractMeta(resolve(dir, file));
        const name = basename(file, ".ts");
        const desc = meta?.description ? dim(meta.description) : "";
        const sub = dirname(file) !== "." ? dim(`[${dirname(file)}]`) : "";
        console.log(`  ${green(String(i + 1))}) ${cyan(name)} ${desc} ${sub}`);
    }

    console.log();

    // Prompt for selection
    const rl = createInterface({ input: stdin, output: stdout });

    const answer = await new Promise<string>((resolve) => {
        rl.question(dim("  Select pipeline (number): "), (a) => {
            resolve(a.trim());
        });
    });

    const idx = parseInt(answer, 10);
    if (isNaN(idx) || idx < 1 || idx > files.length) {
        console.error(red(`❌ Invalid selection: ${answer}`));
        rl.close();
        exit(1);
        return;
    }

    const selectedFile = files[idx - 1]!;
    const filePath = resolve(dir, selectedFile);
    const meta = extractMeta(filePath);

    // Collect args
    const collectedArgs: string[] = [];
    if (meta?.args && meta.args.length > 0) {
        console.log(`\n${bold(`Arguments for ${basename(selectedFile, ".ts")}:`)}`);
        for (const arg of meta.args) {
            const defaultStr = arg.default !== undefined ? dim(`[default: ${arg.default}]`) : "";
            const typeStr = arg.type ? dim(`(${arg.type})`) : "";
            const descStr = arg.description ? dim(arg.description) : "";
            const prompt = `  ${cyan(arg.name)} ${typeStr} ${descStr} ${defaultStr}: `;

            const val = await new Promise<string>((resolve) => {
                rl.question(prompt, (a) => resolve(a.trim()));
            });

            collectedArgs.push(val || String(arg.default ?? ""));
        }
    }

    rl.close();

    // Run
    console.log(`\n${dim("Running")} ${cyan(basename(selectedFile, ".ts"))} ${dim("with args:")} ${collectedArgs.join(" ")}`);
    console.log();

    const runtime = detectRuntime(filePath);
    if (!runtime) {
        console.error(red("❌ No TypeScript runtime found. Install bun, tsx, or ts-node."));
        exit(1);
    }

    const child = spawn(runtime, [filePath, ...collectedArgs], {
        stdio: "inherit",
        env: {
            ...env,
            WEFT_PI_PATH: piPath,
            PI_CODING_AGENT_DIR: WEFT_PI_HOME,
        },
    });

    child.on("exit", (code) => exit(code ?? 0));
    child.on("error", (err) => {
        console.error(red(`❌ Failed to start: ${err.message}`));
        exit(1);
    });
}

// ── Recursive file search ─────────────────────────────────────────────────

function findTsFilesRecursive(dir: string): string[] {
    const result: string[] = [];

    function walk(current: string) {
        const entries = readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = resolve(current, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".ts")) {
                // Only include files that export async function main()
                const content = readFileSync(fullPath, "utf-8");
                if (/export\s+async\s+function\s+main\s*[(\(]/.test(content)) {
                    result.push(relative(dir, fullPath));
                }
            }
        }
    }

    walk(dir);
    return result.sort();
}

// ── Meta extraction ─────────────────────────────────────────────────────────

function extractMeta(filePath: string): PipelineMeta | null {
    try {
        const content = readFileSync(filePath, "utf-8");

        // Find: export const meta = { ... };
        const startMatch = content.match(/export\s+const\s+meta\s*=\s*/);
        if (!startMatch) return null;

        const startIdx = startMatch.index! + startMatch[0].length;
        if (content[startIdx] !== "{") return null;

        // Parse balanced braces
        let depth = 0;
        let endIdx = startIdx;
        for (let i = startIdx; i < content.length; i++) {
            const ch = content[i];
            if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    endIdx = i + 1;
                    break;
                }
            }
            // Skip strings
            if (ch === '"' || ch === "'") {
                const quote = ch;
                i++;
                while (i < content.length && content[i] !== quote) {
                    if (content[i] === "\\") i++; // skip escaped
                    i++;
                }
            }
        }

        if (depth !== 0) return null;

        const raw = content.slice(startIdx, endIdx)
            .replace(/'/g, '"')
            .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')
            // Remove trailing commas before ] or }
            .replace(/,([\s\n]*[\]}])/g, '$1');

        return JSON.parse(raw) as PipelineMeta;
    } catch {
        return null;
    }
}

// ── Runtime detection ────────────────────────────────────────────────────────

function detectRuntime(filePath?: string): string | null {
    // If file is in .lore/, prefer tsx over bun (bun doesn't handle pnpm symlinks well)
    if (filePath?.includes(".lore")) {
        try {
            execSync("tsx --version", { stdio: "ignore" });
            return "tsx";
        } catch { /* fall through */ }
        try {
            execSync("npx --version", { stdio: "ignore" });
            return "npx tsx";
        } catch { /* fall through */ }
    }

    // 1. bun
    try {
        execSync("bun --version", { stdio: "ignore" });
        return "bun";
    } catch { /* not found */ }

    // 2. tsx (local or global)
    try {
        execSync("tsx --version", { stdio: "ignore" });
        return "tsx";
    } catch { /* not found */ }

    // 3. npx tsx (requires node >= 20)
    try {
        execSync("npx --version", { stdio: "ignore" });
        return "npx tsx";
    } catch { /* not found */ }

    return null;
}

main();