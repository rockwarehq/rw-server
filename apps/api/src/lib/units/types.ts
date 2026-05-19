import type { Prisma } from "../../database/generated/client.js";

export type WeightValue = Prisma.Decimal | number | string;
