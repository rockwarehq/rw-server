import prisma, { type Prisma } from "@rw/db";

/*
 * What every document read shares: the row include, the flattening of the
 * current file version onto the document (delegated type — see index.ts), and
 * label and folder-tree helpers. The service (index.ts) and the context
 * resolver (context.ts) both import from here, so neither imports the other.
 */

export interface LabelFilter {
  labelsAny?: string[];
  labelsAll?: string[];
}

export const currentFileSelect = {
  id: true,
  version: true,
  filename: true,
  contentType: true,
  size: true,
  storageKey: true,
} satisfies Prisma.DocumentFileSelect;

export const documentInclude = {
  site: { select: { id: true, name: true } },
  parent: { select: { id: true, name: true, kind: true } },
  links: true,
  currentFile: { select: currentFileSelect },
} satisfies Prisma.DocumentInclude;

export type DocumentRecord = Prisma.DocumentGetPayload<{ include: typeof documentInclude }>;

/**
 * A FILE's bytes live on its current DocumentFile version (delegated type).
 * Callers keep the flat shape they always had — filename, contentType, size,
 * storageKey on the document — plus the current version number.
 */
export function toDocument({ currentFile, ...document }: DocumentRecord) {
  return {
    ...document,
    filename: currentFile?.filename ?? null,
    contentType: currentFile?.contentType ?? null,
    size: currentFile?.size ?? null,
    storageKey: currentFile?.storageKey ?? null,
    version: currentFile?.version ?? null,
  };
}

export function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeLabels(labels?: string[]): string[] {
  if (!labels) return [];
  return [...new Set(labels.map(normalizeLabel).filter(Boolean))];
}

export function applyLabelFilter(where: Prisma.DocumentWhereInput, filter: LabelFilter): void {
  const labelsAny = normalizeLabels(filter.labelsAny);
  const labelsAll = normalizeLabels(filter.labelsAll);

  if (labelsAny.length > 0) {
    where.labels = { hasSome: labelsAny };
  }

  if (labelsAll.length > 0) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { labels: { hasEvery: labelsAll } }];
  }
}

export async function collectDocumentTreeIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];

  while (frontier.length > 0) {
    const children = await prisma.document.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((item) => item.id);
    ids.push(...frontier);
  }

  return ids;
}
