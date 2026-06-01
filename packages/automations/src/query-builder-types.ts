// Minimal vendored subset of react-querybuilder's query tree types.

export interface RuleType {
  field: string;
  operator: string;
  value: unknown;
}

export interface RuleGroupType {
  combinator: string; // "and" | "or"
  rules: Array<RuleGroupType | RuleType>;
  not?: boolean;
}
