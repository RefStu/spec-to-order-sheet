import { z } from "zod";

/** 利用者。DB は accounts/db/schema.ts の users。 */
export const departments = ["planning", "sales", "production", "quality", "admin"] as const;
export const sites = ["japan", "factory"] as const;

export const DEPARTMENT_LABELS: Record<string, string> = {
  planning: "プランニング",
  sales: "営業",
  production: "製造",
  quality: "品質",
  admin: "管理",
};

export const userSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  email: z.string(),
  department: z.enum(departments),
  site: z.enum(sites),
  canApproveOrderSheet: z.boolean(),
  isActive: z.boolean(),
});
export type User = z.infer<typeof userSchema>;

export const createUserInput = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(64),
  email: z.email(),
  department: z.enum(departments),
  site: z.enum(sites).default("japan"),
  canApproveOrderSheet: z.boolean().default(false),
});

/** ⚠ 停止は「消さない」。誰が何をしたかの記録が残るため。 */
export const updateUserInput = z.object({
  name: z.string().min(1).max(64).optional(),
  department: z.enum(departments).optional(),
  site: z.enum(sites).optional(),
  canApproveOrderSheet: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
