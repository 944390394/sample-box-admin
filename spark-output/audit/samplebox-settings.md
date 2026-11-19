# Audit — SampleBox 管理端·系统设置页

- 生成时间：2026-11-20T01:05+08:00
- 走查对象：src/views/system/settings/index.vue（dev /#/system/settings，admin）＋用户截图
- 走查页面数：1（8 分区）
- 走查模式：自动（代码）＋截图混用

## 总览
| 严重度 | 数量 |
| --- | --- |
| 🔴 Blocker | 0 |
| 🟠 Major | 5 |
| 🟡 Minor | 11 |

按维度：visibility2 / user-control2 / error-prevention2 / consistency2 / real-world1 / recognition1 / aesthetic1 / error-recovery1 / help-docs1 / responsive1 / performance1 / flexibility1

## 改版机会点（优先级）
### 🥇 高
1. **统一保存体验**：sticky 保存条＋分区脏标记＋未保存计数＋离开守卫＋统一 label-width（audit-1,2,3,7）
2. **危险操作防错**：数据库切换/全部恢复默认/划拨送检开关 二次确认（typed-confirm＋影响说明）＋跨字段 inline 校验＋各分区恢复默认（audit-5,6,4）
### 🥈 中
3. **表单可读性重构**：长说明移 tooltip/二级灰字行、统一 SectionCard 头、tk/sk 与关键项 ? 帮助（audit-11,9,13,8）
4. **导航与响应式**：图标＋脏点＋scrollspy 高亮＋分区折叠＋键盘导航（audit-10,14,16）
### 🥉 低
5. **错误恢复与性能**：分区 inline 错误条＋重试、重表单懒渲染（audit-12,15）

## 完整 Findings（16 条，六元组见 context/audit.json）
- visibility：audit-1(major 无脏标记/统一保存条) audit-2(minor 成功仅全局toast)
- user-control：audit-3(major 无离开守卫) audit-4(minor 无恢复默认)
- error-prevention：audit-5(major 危险操作无确认) audit-6(minor 跨字段无inline校验)
- consistency：audit-7(major 保存位置/label-width不一) audit-8(minor 卡片头不统一)
- real-world-match：audit-9(minor tk/sk行话)
- recognition：audit-10(minor 导航无图标/脏点/搜索)
- aesthetic：audit-11(major 长说明挤占表单行)
- error-recovery：audit-12(minor 失败仅toast无重试)
- help-docs：audit-13(minor 无?帮助)
- responsive：audit-14(minor 窄屏nav无scrollspy)
- performance：audit-15(minor 全分区一次渲染)
- flexibility：audit-16(minor 无折叠/键盘)

## 下一步
- 按机会点 1-4 落地重构（本会话直接实施），Blocker=0 无需前置修复
- 重构后用真实浏览器流截图验收（browser-use），对照本 findings 逐条关闭
