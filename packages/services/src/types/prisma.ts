// This file must be a module, so we include an empty export.
export {};

declare global {
  namespace PrismaJson {
    type DriverManifest = {
      displayName: string;
      description: string;
      vendor: string;
      category: string;
    };

    type EventCondition =
      | "goes_above"
      | "goes_below"
      | "increments_up"
      | "increments_down"
      | "changes_to"
      | "any_change";

    type EventTriggerCondition = {
      id: string;
      kind: "condition";
      tagId: string;
      tagName?: string;
      deviceId?: string;
      deviceName?: string;
      condition: EventCondition;
      value: string | number | boolean | null;
    };

    type EventTriggerGroup = {
      id: string;
      kind: "group";
      operator: "all" | "any";
      conditions: EventTriggerClause[];
    };

    type EventTriggerClause = EventTriggerCondition | EventTriggerGroup;

    type EventTrigger = {
      operator: "all" | "any";
      clauses: EventTriggerClause[];
    };

    type EventAction = {
      id: string;
      event: string;
      eventDisplayName?: string;
      inputs: Record<string, unknown>;
      continueOnError?: boolean;
    };
  }
}
