import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../../../shared/api-client";

const queryKey = ["accounts"] as const;

export function useUsers() {
  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await apiClient.api.accounts.$get();
      if (!res.ok) throw new Error(`利用者の一覧を取得できませんでした: ${res.status}`);
      return res.json();
    },
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: Parameters<typeof apiClient.api.accounts.$post>[0]["json"]) => {
      const res = await apiClient.api.accounts.$post({ json });
      if (!res.ok) throw new Error(`利用者を追加できませんでした: ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...json
    }: { id: string } & Parameters<
      (typeof apiClient.api.accounts)[":id"]["$patch"]
    >[0]["json"]) => {
      const res = await apiClient.api.accounts[":id"].$patch({ param: { id }, json });
      if (!res.ok) throw new Error(`利用者を更新できませんでした: ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}
