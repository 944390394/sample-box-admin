import { appConfig } from "@/settings";
import SettingsAPI, { type ProductSettings } from "@/api/system/settings";
import fallbackLogo from "@/assets/images/logo.png";

export const useProductStore = defineStore("product", () => {
  const brand = ref({ name: "", title: "", logoDataUrl: "" });
  const security = ref({ idleMinutes: 0, passwordMin: 6, lockAfter: 5 });
  const map = ref({ tk: "", sk: "" });
  const loaded = ref(false);
  let loading: Promise<void> | null = null;

  const displayName = computed(() => brand.value.name || appConfig.title);
  const logoSrc = computed(() => brand.value.logoDataUrl || fallbackLogo);

  function apply(product: ProductSettings) {
    brand.value = {
      name: product.brand?.name || "",
      title: product.brand?.title || "",
      logoDataUrl: product.brand?.logoDataUrl || "",
    };
    security.value = {
      idleMinutes: product.security?.idleMinutes || 0,
      passwordMin: product.security?.passwordMin || 6,
      lockAfter: product.security?.lockAfter || 5,
    };
    map.value = { tk: product.map?.tk || "", sk: product.map?.sk || "" };
    loaded.value = true;
    if (brand.value.title) document.title = brand.value.title;
  }

  function load() {
    if (loaded.value) return Promise.resolve();
    if (!loading) {
      loading = SettingsAPI.get()
        .then((data) => {
          if (data.product) apply(data.product);
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  return { brand, security, map, loaded, displayName, logoSrc, apply, load };
});
