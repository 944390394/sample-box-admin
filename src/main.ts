import { createApp } from "vue";
import App from "./App.vue";

import "element-plus/theme-chalk/dark/css-vars.css";
import "@/styles/index.scss";
import "uno.css";
import "animate.css";

import { setupDirective } from "@/directives";
import { setupRouter } from "@/router";
import { setupStore } from "@/stores";
import { setupI18n } from "@/lang";
import * as ElementPlusIcons from "@element-plus/icons-vue";
import { setupPermissionGuard } from "@/router/guards/permission";

import { setupDiagnostics } from "@/utils/diagnostics";

const app = createApp(App);
setupDiagnostics(app);

setupDirective(app);
setupI18n(app);
setupRouter(app);
setupStore(app);

Object.entries(ElementPlusIcons).forEach(([name, comp]) => app.component(name, comp));

setupPermissionGuard();
// 模板自带的 SSE（字典同步、在线人数）服务端没有对应接口，不再连接；实时数据走 /api/v1/sample/stream

app.mount("#app");
