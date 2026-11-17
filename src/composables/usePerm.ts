import { useUserStore } from "@/stores/user";

/** 按钮级权限判断：当前用户有没有某个权限码。 */
export function usePerm() {
  const user = useUserStore();
  return (code: string) => user.userInfo.perms?.includes(code) ?? false;
}
