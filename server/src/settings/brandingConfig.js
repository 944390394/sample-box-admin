/**
 * 系统名称和图标：网页后台的登录页、侧栏、浏览器标签，小程序的登录页、首页标题都用这里的。
 * 存在 db.config.json 的 branding 里。图标是上传的图片转成的 data URL；为空时各端用自带的默认图标。
 * 小程序在微信里显示的名称和头像（分享卡片、最近使用）要在微信公众平台改，这里改不了。
 */

export const BRANDING_DEFAULTS = {
  title: "智采 · 采样箱",
  slogan: "扫箱码看状态 · 签收 · 建任务单",
  logo: "",
};
const LOGO_MAX = 300000;

export function readBranding(config) {
  const raw = config?.branding && typeof config.branding === "object" ? config.branding : {};
  return {
    title: String(raw.title || BRANDING_DEFAULTS.title),
    slogan: raw.slogan == null ? BRANDING_DEFAULTS.slogan : String(raw.slogan),
    logo: String(raw.logo || ""),
  };
}

/** 保存：名称 1–20 字、标语最多 40 字；图标 png / jpg / webp，约 300 KB 以内，传空串恢复默认，不传不改。 */
export function mergeBrandingSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const body = input && typeof input === "object" ? input : {};
  const previous = readBranding(base);
  const title = String(body.title ?? previous.title).trim();
  if (!title || title.length > 20) throw new Error("系统名称要 1–20 个字");
  const slogan = String(body.slogan ?? previous.slogan).trim();
  if (slogan.length > 40) throw new Error("标语最多 40 个字");
  let logo = previous.logo;
  if (body.logo !== undefined) {
    logo = String(body.logo || "");
    if (logo && !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(logo))
      throw new Error("图标只支持 PNG、JPG、WebP 图片");
    if (logo.length > LOGO_MAX) throw new Error("图标太大，请换一张 200 KB 以内的图片");
  }
  return { ...base, branding: { title, slogan, logo } };
}
