import { eq } from "drizzle-orm";
import { createDb, type DbEnv } from "../../../shared/db";
import { users } from "../db/schema";
import type { User } from "../schema";

type Row = typeof users.$inferSelect;

function toUser(row: Row): User {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    department: row.department,
    site: row.site,
    canApproveOrderSheet: row.canApproveOrderSheet,
    isActive: row.isActive,
  };
}

export async function listUsers(env: DbEnv): Promise<User[]> {
  const rows = await createDb(env).select().from(users).orderBy(users.code).limit(200).all();
  return rows.filter((row) => row.deletedAt === null).map(toUser);
}

export async function createUser(
  env: DbEnv,
  input: {
    code: string;
    name: string;
    email: string;
    department: Row["department"];
    site: Row["site"];
    canApproveOrderSheet: boolean;
  },
): Promise<User> {
  const now = new Date();
  const row = await createDb(env)
    .insert(users)
    .values({ id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return toUser(row);
}

export async function updateUser(
  env: DbEnv,
  id: string,
  patch: Partial<Pick<Row, "name" | "department" | "site" | "canApproveOrderSheet" | "isActive">>,
): Promise<User | undefined> {
  const row = await createDb(env)
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
    .get();
  return row ? toUser(row) : undefined;
}
