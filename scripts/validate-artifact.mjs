import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "roboboy.panel.json"), "utf8"));
const bundlePath = resolve(root, manifest.entryPoint);
const bundle = await readFile(bundlePath);
const integrity = `sha256-${createHash("sha256").update(bundle).digest("base64")}`;
const module = await import(pathToFileURL(bundlePath).href);

if (integrity !== manifest.integrity) throw new Error(`Integrity mismatch: ${integrity}`);
if (module.default?.id !== manifest.id || module.default?.apiVersion !== "2.0.0") {
  throw new Error("The built module does not match roboboy.panel.json.");
}
if (typeof module.default.activate !== "function") throw new Error("activate() is missing.");

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Package and manifest versions differ.");
if (manifest.entryPoint !== "./dist/index.js") throw new Error("Expected one dist/index.js entry point.");
const source = ts.createSourceFile("index.js", bundle.toString("utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function check(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
    || ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    throw new Error("Release bundle contains an unresolved module import.");
  }
  ts.forEachChild(node, check);
}
check(source);

console.log(`Validated ${manifest.id}@${manifest.version}`);
