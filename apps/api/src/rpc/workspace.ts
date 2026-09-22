import { z } from "zod";
import { roles } from "@rw/auth/iam/index";
import { workspace as workspaceService, user } from "../services/account/index.js";
import { authRequired } from "./middleware.js";
import { grant } from "./authz.js";

const emptyInputSchema = z.object({});

export const listUserRoles = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const { workspaceId } = grant(await user.authorizePopulation(context.iam));

  const roleList = await roles.list(workspaceId);

  return {
    data: roleList.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      scope: role.scope,
      permissions: role.permissions,
      isSystem: role.isSystem,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    })),
  };
});

export const listMembers = authRequired.input(emptyInputSchema).handler(async ({ context }) => {
  const { workspaceId, siteId } = grant(await user.authorizePopulation(context.iam));

  return { data: await workspaceService.listMembers(workspaceId, siteId) };
});
