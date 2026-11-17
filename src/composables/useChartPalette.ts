import { useMutationObserver } from "@vueuse/core";
import { ref } from "vue";

/**
 * 图表配色从主题 CSS 变量取，html  class 变化（明暗切换）时自动重算，
 * 让 ECharts 和页面其余部分永远同一套颜色。
 */
export function useChartPalette() {
  const read = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      primary: v("--el-color-primary", "#165dff"),
      success: v("--el-color-success", "#00b42a"),
      warning: v("--el-color-warning", "#ff7d00"),
      danger: v("--el-color-danger", "#f53f3f"),
      info: v("--status-stale", "#86909c"),
      text: v("--el-text-color-primary", "#1d2129"),
      textSecondary: v("--el-text-color-secondary", "#86909c"),
      border: v("--el-border-color-lighter", "#e5e6eb"),
      splitLine: v("--el-border-color-extra-light", "#f0f1f3"),
      bg: v("--content-bg", "#ffffff"),
    };
  };
  const palette = ref(read());
  useMutationObserver(document.documentElement, () => (palette.value = read()), {
    attributes: true,
    attributeFilter: ["class"],
  });
  return palette;
}

export type ChartPalette = ReturnType<typeof useChartPalette>["value"];
