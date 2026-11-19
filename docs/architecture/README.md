# 架构图再生成说明

 canonical 源：`sample-box.structurizr.dsl`（C4）与 `task-lifecycle.dot`（单据生命周期）。
`export/` 下的 `.dot/.svg` 是**派生产物**，改模型只改源文件，然后按下面重跑。

## 本机工具（2026-11-19 安装）

- Graphviz 16.1.1：`C:\Program Files\Graphviz\bin\dot.exe`（winget Graphviz.Graphviz）
- Temurin JRE 21：`C:\Program Files\Eclipse Adoptium\jre-21.0.13.9-hotspot\bin\java.exe`
- Structurizr CLI v2025.11.09：`C:\Users\94439\tools\structurizr-cli\`（zip 解压；GitHub 直连下载不稳时走 API asset 通道）

## 命令（Git Bash）

```bash
J="/c/Program Files/Eclipse Adoptium/jre-21.0.13.9-hotspot/bin/java"
CP='C:\Users\94439\tools\structurizr-cli\lib\*'   # Windows 必须用反斜杠+分号语义，勿用 structurizr.sh（Unix classpath）

# 1. 校验 DSL
"$J" -cp "$CP" com.structurizr.cli.StructurizrCliApplication validate -w docs/architecture/sample-box.structurizr.dsl

# 2. 导出三个视图为 DOT
"$J" -cp "$CP" com.structurizr.cli.StructurizrCliApplication export -w docs/architecture/sample-box.structurizr.dsl -f dot -o docs/architecture/export

# 3. 中文字体修正（导出默认 Arial 会豆腐块）+ 渲染 SVG
sed -i 's/fontname="[^"]*"/fontname="Microsoft YaHei"/g' docs/architecture/export/structurizr-*.dot
for f in docs/architecture/export/structurizr-*.dot; do "/c/Program Files/Graphviz/bin/dot.exe" -Tsvg "$f" -o "${f%.dot}.svg"; done

# 4. 生命周期图
"/c/Program Files/Graphviz/bin/dot.exe" -Tsvg docs/architecture/task-lifecycle.dot -o docs/architecture/task-lifecycle.svg
```

## 已知坑

- Structurizr DSL **按行解析**：styles 属性必须独占一行，不能 `element "x" { shape y }` 单行写。
- `theme default` 需联网拉 static.structurizr.com，离线环境去掉该行（本地 styles 已够用）。
- CLI 无 `svg` 导出格式，走 `-f dot` + Graphviz。
- 在 Qoder 里可直接用插件的 DSL / DOT 查看器打开源文件，无需以上工具链。
