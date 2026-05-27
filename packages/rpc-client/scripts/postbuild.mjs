import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The router types reference Prisma `Decimal` (from @prisma/client/runtime).
// External consumers of this client shouldn't need @prisma/client installed,
// so flatten every Decimal reference to `string` in the emitted declarations.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const distDir = resolve(packageDir, "dist");

function collectDeclarationFiles(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const entryPath = resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      return collectDeclarationFiles(entryPath);
    }

    return entry.name.endsWith(".d.ts") ? [entryPath] : [];
  });
}

for (const declarationPath of collectDeclarationFiles(distDir)) {
  const original = readFileSync(declarationPath, "utf8");
  const prismaRuntimeImportMatch = original.match(
    /import \* as ([\w$]+) from "@prisma\/client\/runtime\/(?:client|library)";\n?/,
  );

  let next = original.replace(/import\("@prisma\/client\/runtime\/(?:client|library)"\)\.Decimal/g, "string");

  if (prismaRuntimeImportMatch) {
    const prismaRuntimeAlias = prismaRuntimeImportMatch[1];
    const decimalReference = new RegExp(`${prismaRuntimeAlias}\\.Decimal`, "g");

    next = next.replace(decimalReference, "string");

    if (!next.includes(`${prismaRuntimeAlias}.`)) {
      next = next.replace(prismaRuntimeImportMatch[0], "");
    }
  }

  if (next !== original) {
    next = next.replace(/^\/\/\# sourceMappingURL=.*$/m, "").trimEnd() + "\n";
    writeFileSync(declarationPath, next);
  }
}
