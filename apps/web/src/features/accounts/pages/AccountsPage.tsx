import { useState, type FormEvent } from "react";
import { Button } from "../../../shared/ui/button";
import { EmptyState } from "../../../shared/ui/card";
import { Input, Select } from "../../../shared/ui/input";
import { useCreateUser, useUpdateUser, useUsers } from "../hooks/use-users";
import { departments, DEPARTMENT_LABELS } from "../schema";

/**
 * ユーザー管理。
 *
 * ⚠⚠ **GIP への利用者の作成はここではできない** (Worker は GIP の Admin の資格情報を持たない)。
 *   この画面が持つのは **社内の users 表**だけ。サインインできる人を増やすには、
 *   GIP の管理コンソールで同じ **メールアドレス**の利用者を作る (email で突き合わせる)。
 * ⚠ 停止は「消さない」。誰が何をしたかの記録が残るため。
 * ⚠ 役割は PoC では「承認できる / できない」の 2 つだけ。
 */
export default function AccountsPage() {
  const users = useUsers();
  const create = useCreateUser();
  const update = useUpdateUser();
  const [form, setForm] = useState({
    code: "",
    name: "",
    email: "",
    department: "planning" as (typeof departments)[number],
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      { ...form, site: "japan", canApproveOrderSheet: false },
      { onSuccess: () => setForm({ code: "", name: "", email: "", department: "planning" }) },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
        ここで管理するのは社内の利用者情報です。<strong>サインインできるようにするには</strong>、
        GIP の管理コンソールで同じメールアドレスの利用者を作ってください (メールアドレスで
        突き合わせます)。
      </p>

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          社員コード
          <Input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          氏名
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          メールアドレス
          <Input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          部署
          <Select
            value={form.department}
            onChange={(e) =>
              setForm({ ...form, department: e.target.value as (typeof departments)[number] })
            }
          >
            {departments.map((d) => (
              <option key={d} value={d}>
                {DEPARTMENT_LABELS[d]}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" disabled={create.isPending}>
          利用者を追加
        </Button>
      </form>

      {create.isError ? (
        <p className="text-sm text-danger">
          追加できませんでした。社員コードとメールアドレスが重複していないか確認してください。
        </p>
      ) : null}

      {users.isPending ? <EmptyState>読み込んでいます…</EmptyState> : null}
      {users.data?.length === 0 ? <EmptyState>まだ利用者がいません。</EmptyState> : null}

      {users.data && users.data.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <thead className="bg-surface-muted text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">コード</th>
                <th className="px-3 py-2 font-medium">氏名</th>
                <th className="px-3 py-2 font-medium">メールアドレス</th>
                <th className="px-3 py-2 font-medium">部署</th>
                <th className="px-3 py-2 font-medium">承認</th>
                <th className="px-3 py-2 font-medium">状態</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => (
                <tr key={user.id} className="border-t border-border">
                  <td className="px-3 py-2">{user.code}</td>
                  <td className="px-3 py-2">{user.name}</td>
                  <td className="px-3 py-2 text-ink-muted">{user.email}</td>
                  <td className="px-3 py-2">
                    <Select
                      value={user.department}
                      onChange={(e) =>
                        update.mutate({
                          id: user.id,
                          department: e.target.value as (typeof departments)[number],
                        })
                      }
                    >
                      {departments.map((d) => (
                        <option key={d} value={d}>
                          {DEPARTMENT_LABELS[d]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={user.canApproveOrderSheet}
                        onChange={(e) =>
                          update.mutate({ id: user.id, canApproveOrderSheet: e.target.checked })
                        }
                      />
                      できる
                    </label>
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant={user.isActive ? "outline" : "ghost"}
                      onClick={() => update.mutate({ id: user.id, isActive: !user.isActive })}
                    >
                      {user.isActive ? "停止する" : "再開する"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
