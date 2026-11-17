import type { LocationQuery } from "vue-router";

/**
 * 筛选条件和地址栏同步：刷新、从详情页返回时筛选还在，链接也能直接分享。
 * defaults 里的值不写进地址栏，数字字段按默认值的类型转换。
 */
export function useUrlQuery<T extends Record<string, string | number>>(defaults: T) {
  const route = useRoute();
  const router = useRouter();
  const read = (query: LocationQuery) => {
    const out = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      const raw = query[key as string];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value == null || value === "") continue;
      out[key] = (
        typeof defaults[key] === "number" ? Number(value) || defaults[key] : String(value)
      ) as T[keyof T];
    }
    return out;
  };
  const state = reactive(read(route.query)) as T;

  /** 写回地址栏（replace，不增加历史记录）。 */
  function sync() {
    const query: Record<string, string> = {};
    for (const key of Object.keys(defaults)) {
      const value = (state as Record<string, string | number>)[key];
      if (value !== defaults[key] && value !== "" && value != null) query[key] = String(value);
    }
    void router.replace({ query });
  }

  function reset() {
    Object.assign(state, defaults);
    sync();
  }

  return { state, sync, reset };
}
