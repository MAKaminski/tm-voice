import type { Adapters } from "@tm/adapters";
import type { Producer } from "@tm/api";
import type { AnyDb } from "@tm/db";
import type { Config, JobEnvelope } from "@tm/shared";

export interface Ctx { cfg: Config; db: AnyDb; adapters: Adapters; producer: Producer }
export type Processor<T extends Record<string, unknown> = Record<string, unknown>> = (ctx: Ctx, payload: JobEnvelope & T) => Promise<unknown>;
