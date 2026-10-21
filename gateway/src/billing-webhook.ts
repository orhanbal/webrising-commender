import crypto from "node:crypto";
import { z } from "zod";

export const billingIngressVersion = 1;
export const maximumEventBytes = 65536;
export const billingProviderSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);
export const billingEventIdSchema = z.string().min(1).max(255);
