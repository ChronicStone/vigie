import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { useScope } from "./scope.ts";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, gcTime: 10 * 60_000, retry: (count, error) => count < 1 && errorStatus(error) >= 500, refetchOnWindowFocus: false } },
});

/** Server errors carry their status in front of the message: "404|This trace has no spans left." */
export const errorStatus = (error: unknown) => Number((error instanceof Error ? error.message : "").match(/^(\d{3})\|/)?.[1] ?? 500);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^\d{3}\|/, "");

type AnyFn = (options: any) => Promise<any>;
type Input<F extends AnyFn> = NonNullable<Parameters<F>[0]> extends { data: infer D } ? D : undefined;
type Output<F extends AnyFn> = Awaited<ReturnType<F>>;
type Scope = { env: "PRD" | "STG" | "DEV"; from: number; to: number; services?: string };
type Options<F extends AnyFn> = Partial<Omit<UseQueryOptions<Output<F>, Error>, "queryKey" | "queryFn">>;

const keyOf = (fn: AnyFn) => (fn as AnyFn & { url?: string }).url ?? fn.name;

/** Calls a server function. Old data stays on screen while new data loads, so the page never blinks. */
export function useFn<F extends AnyFn>(fn: F, data: Input<F>, options: Options<F> = {}) {
  const { live } = useScope();
  return useQuery<Output<F>, Error>({
    queryKey: [keyOf(fn), data],
    queryFn: ({ signal }) => fn({ data, signal }),
    placeholderData: keepPreviousData,
    refetchInterval: live ? 5000 : false,
    ...options,
  });
}

/** The same, under the global time, environment and service scope. */
export function useScoped<F extends AnyFn>(fn: F, extra: Omit<Input<F>, keyof Scope>, options: Options<F> = {}) {
  const scope = useScope();
  return useFn(fn, { ...scope.params, ...extra } as Input<F>, options);
}

export function useAct<F extends AnyFn>(fn: F) {
  const client = useQueryClient();
  return useMutation<Output<F>, Error, Input<F>>({
    mutationFn: (data) => fn({ data }),
    onSuccess: () => void client.invalidateQueries(),
  });
}
