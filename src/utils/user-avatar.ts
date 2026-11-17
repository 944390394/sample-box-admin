/** 业务账户统一使用文字头像，不读取历史头像地址。 */
export function userAvatarText(user: { nickname?: string; username?: string }): string {
  const name = user.nickname?.trim() || user.username?.trim() || "用";
  return Array.from(name)[0];
}
