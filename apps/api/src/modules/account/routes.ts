import type { FastifyInstance } from "fastify";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";
import { deleteAccount, SubscriptionCancelUnavailable, type AccountDeps } from "./delete";

export type { AccountDeps } from "./delete";

/** `DELETE /v1/account` (Story 5.7 / T075). */
export function registerAccountRoutes(app: FastifyInstance, deps: AccountDeps): void {
  app.delete("/v1/account", { config: { allowDeleted: true } }, async (req, reply) => {
    const user = requireUser(req);
    try {
      await deleteAccount(deps, user);
    } catch (err) {
      req.log.error({ errName: (err as Error).name }, "account deletion incomplete");
      if (err instanceof SubscriptionCancelUnavailable) {
        throw new ApiError("CONFLICT", "Cancel your subscription first, then delete your account.");
      }
      // Safe to retry: every step is idempotent.
      throw new ApiError("INTERNAL", "Couldn't finish deleting your account. Try again.");
    }
    req.log.info("account deleted");
    return reply.code(204).send();
  });
}
