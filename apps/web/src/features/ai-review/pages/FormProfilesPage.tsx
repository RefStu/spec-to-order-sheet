import { useState } from "react";
import { Button } from "../../../shared/ui/button";
import { Card, CardTitle, EmptyState } from "../../../shared/ui/card";
import { Input, Select, Textarea } from "../../../shared/ui/input";
import {
  useCreateFormProfile,
  useDeactivatePrompt,
  useFormProfiles,
  useSavePrompt,
  useUpdateFormProfile,
} from "../hooks/use-form-profiles";
import {
  FORM_DOC_KIND_LABEL,
  isPromptModel,
  MODEL_OPTIONS,
  PROMPT_ROLE_LABEL,
  promptRoleSchema,
  type FormDocKind,
  type Prompt,
  type PromptRole,
} from "../schema";

/**
 * ★ 発注書分類。
 *
 * ⚠⚠ **今は読み取りに効かない。** ai は様式の候補も指示文も受け取らない
 *   (`apps/ai/src/features/doc-extract/contract.ts`)。画面も出していない (`../client.ts`)。
 * ⚠⚠ **今回通すのは様式 1 つの例。様式は増える前提。**
 *   だから「この様式のときはこの指示文」を**データ**に持ち、
 *   様式が増えても**プログラムを書き換えずに済む**ようにする。
 * ⚠ **指示文を入れなければ ai の既定の指示文で読む。** ここで入れたものは「上書き」で、
 *   やめれば既定に戻る。空のまま運用してよい。
 * ⚠ 見本のアップロードと様式の自動判定はまだ無い。
 *   様式を当てるのは読み取りの workflow の分類ノード。
 */
export default function FormProfilesPage() {
  const { data, isPending, error } = useFormProfiles();
  const createProfile = useCreateFormProfile();
  const updateProfile = useUpdateFormProfile();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [docKind, setDocKind] = useState<FormDocKind>("mixed");
  const [hint, setHint] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  if (isPending) return <EmptyState>読み込んでいます…</EmptyState>;
  if (error) return <EmptyState>{error.message}</EmptyState>;

  const profiles = data?.profiles ?? [];
  const prompts = data?.prompts ?? [];

  async function onCreate() {
    if (!code.trim() || !name.trim()) return;
    try {
      await createProfile.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        docKind,
        hint: hint.trim() || null,
      });
      setCode("");
      setName("");
      setHint("");
      setNotice("様式を追加しました。");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "追加できませんでした");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {notice && <p className="text-sm text-ink-muted">{notice}</p>}

      <Card>
        <CardTitle>様式</CardTitle>
        <p className="pb-3 text-sm text-ink-muted">
          今の読み取りはこの一覧を使いません。様式の見分け方は ai 側の指示文に書いてあります。
        </p>

        {profiles.length === 0 ? (
          <EmptyState>まだ様式がありません。下の欄から 1 つ足してください。</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-ink-muted">
              <tr>
                <th className="py-2">code</th>
                <th>名前</th>
                <th>対象</th>
                <th>手がかり (見分け方と部品の構成)</th>
                <th>版</th>
                <th>使用</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((profile) => (
                <tr key={profile.id} className="border-t border-border">
                  <td className="py-2 font-mono text-xs">{profile.code}</td>
                  <td>{profile.name}</td>
                  <td>{FORM_DOC_KIND_LABEL[profile.docKind]}</td>
                  <td className="max-w-80 truncate text-ink-muted">{profile.hint ?? "—"}</td>
                  <td>v{profile.version}</td>
                  <td>
                    <Button
                      variant={profile.isActive ? "outline" : "ghost"}
                      size="sm"
                      onClick={() =>
                        updateProfile.mutate({ id: profile.id, isActive: !profile.isActive })
                      }
                    >
                      {profile.isActive ? "使用中" : "止めている"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
          <label className="flex flex-col gap-1 text-sm">
            code
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="P1" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            名前
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="様式パターン①"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            対象
            <Select value={docKind} onChange={(e) => setDocKind(e.target.value as FormDocKind)}>
              {Object.entries(FORM_DOC_KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          {/*
            ⚠⚠ **様式ごとの差はここ (データ) に置く。** コードに `if (様式パターン①)` を
            書くと 2 件目で必ず壊れる。⚠ 今は ai が様式の候補を受け取らない
            (`apps/ai/src/features/doc-extract/contract.ts`) ので、ここに書いた文は読み取りに効かない。
          */}
          <label className="flex flex-1 flex-col gap-1 text-sm">
            手がかり (見分け方と部品の構成・任意)
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="例: 表題は「発注書」。1 ページ目が発注書で、明細 1 件につき依頼書が 1 枚続く"
            />
          </label>
          <Button onClick={() => void onCreate()} disabled={createProfile.isPending}>
            様式を追加
          </Button>
        </div>
      </Card>

      {promptRoleSchema.options.map((role) => (
        <PromptCard key={role} role={role} prompts={prompts} profiles={profiles} />
      ))}
    </div>
  );
}

/**
 * ノード 1 つぶんの指示文。
 *
 * ⚠ **読み取りは「分類 → 発注書 → 依頼書」の 3 ノード**で、それぞれ別の指示文を使う。
 *   まとめて 1 本にすると、どの段が悪くて読めなかったのかが分からなくなる。
 */
function PromptCard({
  role,
  prompts,
  profiles,
}: {
  role: PromptRole;
  prompts: Prompt[];
  profiles: { id: string; code: string; name: string }[];
}) {
  const save = useSavePrompt();
  const deactivate = useDeactivatePrompt();
  const mine = prompts.filter((p) => p.role === role);
  const active = mine.find((p) => p.isActive);

  const [body, setBody] = useState(active?.body ?? "");
  // ⚠ 一覧を絞る前に保存された版が残っていることがある。そのときは「既定」に落として出す
  //   (読み出しは緩いままなので、画面は落ちない)。
  const [modelName, setModelName] = useState(
    isPromptModel(active?.modelName) ? active.modelName : "",
  );
  const [formProfileId, setFormProfileId] = useState(active?.formProfileId ?? "");
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <CardTitle>{PROMPT_ROLE_LABEL[role]}</CardTitle>
        <span className="text-sm text-ink-muted">
          {active
            ? `使用中: v${active.version}${active.modelName ? ` / ${active.modelName}` : ""}`
            : "既定の指示文を使用中 (ai に入っているもの)"}
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "閉じる" : active ? "指示文を直す" : "指示文を上書きする"}
        </Button>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => deactivate.mutate(active.id)}
            disabled={deactivate.isPending}
          >
            既定に戻す
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder="このノードに渡す指示文。空のままなら ai の既定を使います。"
          />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              モデル (任意)
              {/* ⚠⚠ **一覧からしか選ばせない。** 一覧に無い文字列を保存すると、読み取りの
                  要求が ai の契約で弾かれて 400 になり、ジョブ全体が失敗する。 */}
              <Select value={modelName} onChange={(e) => setModelName(e.target.value)}>
                <option value="">既定のモデルを使う</option>
                {MODEL_OPTIONS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              様式 (任意)
              <Select value={formProfileId} onChange={(e) => setFormProfileId(e.target.value)}>
                <option value="">すべての様式に使う</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.code} / {profile.name}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex-1" />
            <Button
              onClick={() =>
                save.mutate(
                  {
                    role,
                    body,
                    modelName: isPromptModel(modelName) ? modelName : null,
                    formProfileId: formProfileId || null,
                  },
                  { onSuccess: () => setOpen(false) },
                )
              }
              disabled={save.isPending || body.trim().length === 0}
            >
              保存して使用中にする
            </Button>
          </div>
          {/* ⚠ 上書きではなく版が増える。前の版に戻せるようにしてある。 */}
          <p className="text-xs text-ink-muted">
            保存すると新しい版になります。前の版は残り、どの版で読んだかはジョブに記録されます。
          </p>
        </div>
      )}
    </Card>
  );
}
