import { AvailabilityService, materialize } from "@tm/api";
import type { Processor } from "../context.js";

export const availabilityMaterialize: Processor = async (ctx) => {
  const r = await materialize(ctx.db, ctx.adapters.hcp);
  await new AvailabilityService(ctx.db).invalidate();
  return r;
};
export const availabilityInvalidate: Processor = async (ctx) => ({ deleted: await new AvailabilityService(ctx.db).invalidate() });
