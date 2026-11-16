<template>
  <div class="layout-wrapper">
    <component :is="currentLayoutComponent" />
    <Settings v-if="showSettings" />
  </div>
</template>

<script setup lang="ts">
import { useRoute } from "vue-router";
import { useLayout } from "./composables/useLayout";
import { useLayoutDevice } from "./composables/useLayoutDevice";
import { LayoutMode } from "@/enums/settings";
import LeftLayout from "./modes/LeftLayout.vue";
import TopLayout from "./modes/TopLayout.vue";
import MixLayout from "./modes/MixLayout.vue";
import DoubleLayout from "./modes/DoubleLayout.vue";
import Settings from "./components/LayoutSettings.vue";
import { useProductStore } from "@/stores/product";
import { useUserStore } from "@/stores/user";

const route = useRoute();
const router = useRouter();
const productStore = useProductStore();
const userStore = useUserStore();
const { currentLayout, showSettings } = useLayout();
let idleTimer = 0;

function resetIdle() {
  window.clearTimeout(idleTimer);
  const minutes = productStore.security.idleMinutes;
  if (!minutes || !userStore.isLoggedIn()) return;
  idleTimer = window.setTimeout(
    () => {
      userStore.logout().finally(() => {
        ElMessage.info("长时间未操作，已退出登录");
        router.push("/login");
      });
    },
    minutes * 60 * 1000
  );
}

useLayoutDevice();

onMounted(() => {
  productStore
    .load()
    .catch(() => undefined)
    .finally(resetIdle);
  window.addEventListener("pointerdown", resetIdle);
  window.addEventListener("keydown", resetIdle);
});

onBeforeUnmount(() => {
  window.clearTimeout(idleTimer);
  window.removeEventListener("pointerdown", resetIdle);
  window.removeEventListener("keydown", resetIdle);
});

watch(() => productStore.security.idleMinutes, resetIdle);

const currentLayoutComponent = computed(() => {
  const override = route.meta?.layout as LayoutMode | undefined;
  const layout = override ?? currentLayout.value;

  switch (layout) {
    case LayoutMode.TOP:
      return TopLayout;
    case LayoutMode.MIX:
      return MixLayout;
    case LayoutMode.DOUBLE:
      return DoubleLayout;
    default:
      return LeftLayout;
  }
});
</script>

<style lang="scss" scoped>
.layout-wrapper {
  width: 100%;
  height: 100%;
}
</style>
