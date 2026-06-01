export type RefContext = Record<string, unknown>;

export interface RefOption {
  id: string;
  label: string;
  meta?: Record<string, unknown>;
}


export interface RefSource {
  key: string;
  list(ctx: RefContext): Promise<RefOption[]>;
}

export interface RefRegistry {
  register(source: RefSource): RefRegistry;
  get(key: string): RefSource | undefined;
  keys(): string[];
}

export function createRefRegistry(): RefRegistry {
  const sources = new Map<string, RefSource>();
  const registry: RefRegistry = {
    register(source) {
      sources.set(source.key, source);
      return registry;
    },
    get(key) {
      return sources.get(key);
    },
    keys() {
      return [...sources.keys()];
    },
  };
  return registry;
}
