import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api-client";
import { formProfileListSchema, type FormDocKind, type PromptRole } from "../schema";

/**
 * 様式と指示文 (発注書分類の画面)。
 *
 * ⚠ 自分の feature の API なので、本来は `hc` の型付き RPC を使える。ここでは
 *   応答を zod で確かめる形に揃えてある (契約が崩れたら画面ではなくここで落ちる)。
 */
const KEY = ["form-profiles"] as const;

async function readList() {
  const res = await apiFetch("/api/ai-review/form-profiles");
  if (!res.ok) throw new Error(`様式を取得できませんでした: ${res.status}`);
  return formProfileListSchema.parse(await res.json());
}

export function useFormProfiles() {
  return useQuery({ queryKey: KEY, queryFn: readList });
}

async function post(path: string, body: unknown) {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 409) throw new Error("その code の様式は既にあります");
    throw new Error(`保存できませんでした: ${res.status}`);
  }
  return res.json();
}

export function useCreateFormProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      code: string;
      name: string;
      docKind: FormDocKind;
      hint: string | null;
    }) => post("/api/ai-review/form-profiles", input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateFormProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; isActive?: boolean; hint?: string | null }) => {
      const { id, ...patch } = input;
      const res = await apiFetch(`/api/ai-review/form-profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`更新できませんでした: ${res.status}`);
      return res.json();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * 指示文を保存して使用中にする。
 * ⚠ **上書きではなく版が増える。** 前の版は残るので、あとから比べられる。
 */
export function useSavePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      role: PromptRole;
      body: string;
      modelName: string | null;
      formProfileId: string | null;
    }) => post("/api/ai-review/prompts", input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

/** 指示文をやめる (= ai の既定の指示文に戻る)。 */
export function useDeactivatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/api/ai-review/prompts/${id}/deactivate`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
