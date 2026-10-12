import type { App } from "vue";
import { createPinia, getActivePinia, type Pinia } from "pinia";

const store = createPinia();

/** 组件外取 store 时用正在服务页面的那一份，避免热更新再造一份空状态。 */
export function activePinia(): Pinia {
  return getActivePinia() ?? store;
}

export function setupStore(app: App<Element>) {
  app.use(store);
}

export * from "./app";
export * from "./dict";
export * from "./permission";
export * from "./settings";
export * from "./tags-view";
export * from "./tenant";
export * from "./user";
export { store };
