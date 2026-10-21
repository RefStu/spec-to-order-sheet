import { zValidator } from "@hono/zod-validator";
import { createApp } from "../../../shared/hono";
import { createUserInput, updateUserInput } from "../schema";
import { createUser, listUsers, updateUser } from "../services/user-service";

/**
 * /api/accounts 配下 (prefix は app/routes.gen.ts が付ける)。
 *
 * ⚠ **メソッドチェーンのまま書くこと。** 途中で変数に代入すると hc の RPC 型が落ちる。
 * ⚠⚠ **GIP への利用者の作成はここではやっていない** (Worker は Admin の資格情報を持たない)。
 *   ここが持つのは社内の users 表だけ。GIP の利用者は GIP 側に作り
 *   (作り方は infra/terraform/README.md)、users にも同じ email の行を入れて**email で突き合わせる**
 *   (users.email は unique)。
 */
export const routes = createApp()
  .get("/", async (c) => c.json(await listUsers(c.env)))
  .post("/", zValidator("json", createUserInput), async (c) =>
    c.json(await createUser(c.env, c.req.valid("json")), 201),
  )
  .patch("/:id", zValidator("json", updateUserInput), async (c) => {
    const user = await updateUser(c.env, c.req.param("id"), c.req.valid("json"));
    return user ? c.json(user) : c.json({ error: "not_found" }, 404);
  });
