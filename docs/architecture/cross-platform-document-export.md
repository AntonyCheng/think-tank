# 跨平台研究报告文档导出架构

状态：建议方案  
调研日期：2026-07-28  
适用平台：Windows、Linux、macOS

## 结论

建议将最终 Markdown 报告视为唯一内容源，在独立的导出模块中先解析为规范化文档模型，再分别生成 DOCX 和 PDF：

```text
Markdown report
      │
      ▼
Normalized document model
  headings / paragraphs / lists / tables / links / citations / images
      ├──────────────────────────────┐
      ▼                              ▼
python-docx renderer             ReportLab Platypus renderer
      ▼                              ▼
    DOCX                            PDF
```

- DOCX 使用 `python-docx` 直接生成，不调用 Microsoft Word 或 LibreOffice。
- PDF 使用 ReportLab 直接生成，不经过 DOCX，也不调用 Microsoft Word 或 LibreOffice。
- LibreOffice 不进入生产导出路径；它只作为可选的视觉验收工具，把测试 DOCX 渲染为 PDF 或图片供人工、截图或像素级回归检查。
- AO 和 GPTR 只负责产出 Markdown；导出模块消费最终报告，不要求修改 AO/GPTR。

这个设计的目标是“内容和样式规则一致”，而不是让 DOCX 与 PDF 像素完全相同。两种格式由不同排版引擎生成，分页和换行出现少量差异是正常现象。

## 为什么 DOCX 不需要 Office

`python-docx` 是用于读取、创建和更新 Word 2007 及以后版本 `.docx` 文件的 Python 库。官方示例直接创建 `Document()` 并调用 `document.save("test.docx")`，生成过程没有启动 Word 或 LibreOffice。[python-docx：Working with Documents](https://python-docx.readthedocs.io/en/stable/user/documents.html)

DOCX 本质上是 Open XML 文档包。`python-docx` 自带默认空白模板，也可以加载项目提供的 `.docx` 模板，在保留模板样式、页眉和页脚的基础上写入内容。官方文档明确说明，文档的大量外观由模板中独立保存的样式、页眉和页脚决定。[python-docx：Working with Documents](https://python-docx.readthedocs.io/en/stable/user/documents.html)

因此生产实现应采用：

1. 项目内保存一个受版本控制的 DOCX 模板。
2. 使用模板中的 `Normal`、`Title`、`Heading 1` 至 `Heading 3`、引用、代码、表格等命名样式。
3. 将规范化文档模型映射为 `python-docx` 的段落、run、列表、表格、图片和超链接。
4. 直接保存到文件或二进制流。官方 API 支持路径和 file-like object，因此也可以直接写入内存后作为 HTTP 下载响应返回。[python-docx：Working with Documents](https://python-docx.readthedocs.io/en/stable/user/documents.html)

### DOCX 运行时依赖

`python-docx` 的官方安装说明只列出 Python 包依赖 `lxml`，通过 pip 安装时会自动解析依赖；没有 Microsoft Office、LibreOffice 或平台 GUI 依赖。[python-docx：Installing](https://python-docx.readthedocs.io/en/latest/user/install.html)

`lxml` 本身包含原生 XML 组件。其官方安装说明为常见平台提供二进制发行包，但从源码构建时会涉及 libxml2、libxslt 等构建依赖；macOS 也有单独的 universal2 wheel 说明。[lxml：Installation](https://lxml.de/installation.html) 因此部署应锁定受支持的 CPython 和平台，优先安装官方 wheel，避免在生产镜像中意外退回源码编译。

在三个目标平台都应执行生成与重新打开测试。Windows 上处理文件流时必须使用二进制模式；官方文档指出 Zipfile 在 Windows 和部分 Linux 环境中需要二进制模式。[python-docx：Working with Documents](https://python-docx.readthedocs.io/en/stable/user/documents.html)

### DOCX 功能边界

`python-docx` 的功能集不是完整的 Word 自动化接口。官方文档明确指出某些功能仍不能直接新增或修改，例如脚注；已有但库不理解的内容通常可以在加载、保存模板时保留。[python-docx：Working with Documents](https://python-docx.readthedocs.io/en/stable/user/documents.html)

这意味着：

- 第一版引用使用可读的正文来源超链接加文末参考文献，不承诺生成 Word 原生脚注。
- 若以后必须提供原生脚注、自动目录域或复杂域代码，应单独评估直接操作 OOXML，不能把安装 Word 当作默认解决办法。
- 目录可以先输出可点击的静态目录；由 Word 打开后自动更新的域属于另一项兼容性需求。

## 为什么 PDF 不需要 Office

ReportLab 的 `pdfgen.canvas` 直接创建 PDF 文件；官方最小示例是创建 `canvas.Canvas("hello.pdf")`、绘制文字并调用 `save()`。它不经过打印机驱动、Word、LibreOffice 或浏览器。[ReportLab：Graphics and text with pdfgen](https://docs.reportlab.com/reportlab/userguide/ch2_graphics/)

研究报告不应使用低层 Canvas 手工计算所有坐标，而应使用 ReportLab Platypus 的 `DocTemplate`、`PageTemplate`、`Frame`、`Paragraph`、`Table` 等流式排版对象，将标题、段落、列表、表格、图片、分页符、页眉页脚和链接映射为 flowables。[ReportLab：Platypus](https://docs.reportlab.com/reportlab/userguide/ch5_platypus/) Canvas 只用于页码、页眉页脚和其他页面级装饰。

### PDF 运行时依赖

ReportLab 官方说明，从 4.0 起核心包已经迁移为纯 Python，基础 PDF 生成只需 `pip install reportlab`。`accel`、`renderpm` 和 PyCairo 都是可选扩展；PyCairo 主要用于位图和更丰富的图形场景，而不是文本型 PDF 的硬依赖。[ReportLab：Open source installation](https://docs.reportlab.com/install/open_source_installation/)

因此基础研究报告 PDF 的生产镜像不需要安装 LibreOffice，也不需要系统级 Cairo。若后续加入需要栅格化的复杂图表，再按功能显式增加 `reportlab[pycairo]`，并为三个平台分别验证 wheel 和原生库。

## 字体与中文是主要的跨平台约束

不要依赖 `Arial`、`微软雅黑`、`苹方`、`思源黑体` 等字体“恰好安装在操作系统中”。不同系统和不同基础镜像的字体集合不同；Microsoft 也记录了缺失字体会使 Office 文档显示不同的问题。[Microsoft：Error messages opening Office documents when fonts are missing](https://learn.microsoft.com/en-us/office/troubleshoot/office-suite-issues/missing-fonts-opening-documents)

### PDF 字体

ReportLab 接收 Unicode/UTF-8 文本，但字符能否显示取决于所用字体是否包含相应 glyph。官方文档说明，TrueType 字体支持 Unicode/UTF-8，并可通过 `TTFont` 注册、嵌入 PDF；对于受控服务器部署，官方建议将所需字体作为应用的一部分打包，而不是依赖系统字体搜索路径。[ReportLab：Fonts](https://docs.reportlab.com/reportlab/userguide/ch3_fonts/)

生产要求：

- 在应用资产中固定一套覆盖简体中文、拉丁字符、常用标点和数学符号的字体文件。
- 至少提供 Regular 和 Bold；若需要真实斜体，再提供 Italic 和 Bold Italic。
- 启动时验证字体文件存在，并验证一组中英文哨兵字符均有 glyph。
- ReportLab 注册并映射完整字体家族，确保段落内粗体、斜体不会回退到平台字体。
- 将字体子集嵌入 PDF。ReportLab 官方提醒，亚洲字体解析和嵌入较大子集会增加处理时间和文件大小，应纳入性能测试。[ReportLab：Fonts](https://docs.reportlab.com/reportlab/userguide/ch3_fonts/)

可选字体候选是 Noto Sans CJK。其官方仓库采用 SIL Open Font License 1.1，许可文本允许在符合条件的情况下打包、嵌入和再分发字体；正式纳入项目前仍应由项目按实际分发方式完成许可证审查，并随字体保留许可证文件。[Noto CJK Sans license](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE)

字体资产应选择经过三个目标平台验证的固定 TTF 文件，并锁定版本和哈希。
是否使用变量字体由实际排版引擎兼容测试决定。Noto CJK 官方提供多种区域和
部署格式，不能把“任意 Noto CJK 文件”视为可互换资产。
[Noto Sans CJK：Downloading](https://github.com/notofonts/noto-cjk/blob/main/Sans/README.md)

当前第一版已固定使用官方 `NotoSansSC-VF.ttf`，随应用嵌入 PDF，SHA-256 为
`D68BAFCB48A2707749396AA12BBBD833CB70401F3A9A689FD2902C7E0D295964`；
对应 OFL 许可证与字体文件放在同一资产目录。跨平台 CI 会断言生成后的 PDF
能够抽取出中文哨兵文本。

### DOCX 字体

DOCX 中设置字体名称并不等于嵌入字体。`python-docx` 的字体 API 将名称写入 WordprocessingML 的 `w:rFonts` 属性，并区分 ASCII、复杂文字、东亚文字等字符范围。[python-docx：Font analysis](https://python-docx.readthedocs.io/en/latest/dev/analysis/features/text/font.html)

Microsoft 的 Open XML 说明也表明，只有存在 `w:embedRegular` 等嵌入关系时，对应字体才被存入文档；省略该元素就没有存储该字形。[Microsoft Open XML：EmbedRegularFont](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.embedregularfont)

第一版建议：

- DOCX 模板显式设置拉丁和东亚字体名称。
- 选择用户环境中较常见的回退字体，并接受不同编辑器的轻微排版差异。
- 不在第一版实现 DOCX 字体嵌入，因为它需要额外 OOXML 关系处理，还受字体嵌入许可约束。
- PDF 始终嵌入项目字体，因此 PDF 是固定版式的权威交付物；DOCX 是可编辑交付物。

## Markdown 到文档模型

不要分别用两套正则表达式解释 Markdown。应使用同一个 Markdown 解析器生成语法树，再转换为项目自己的小型文档模型。第一版支持范围应明确限定为：

- H1 至 H3 标题
- 段落与软/硬换行
- 粗体、斜体、行内代码
- 有序和无序列表，限定嵌套深度
- 表格
- HTTP/HTTPS 超链接
- 图片
- 可读的来源链接和文末参考文献
- 水平分隔线和显式分页符

遇到不支持的节点时应记录 warning 并输出其纯文本，而不是静默丢失。DOCX 与 PDF 渲染器只消费规范化模型，避免两种输出对相同 Markdown 产生不同语义。

远程图片必须先经过下载大小、超时、媒体类型和尺寸限制，再存入任务隔离的临时目录；渲染器不应直接无限制访问任意 URL。

## LibreOffice 的角色

LibreOffice 官方支持 `--headless` 无界面启动，也支持 `--convert-to pdf:writer_pdf_Export --outdir ...` 批量转换。[LibreOffice：Starting with parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

但它不应成为默认生产导出引擎，原因是：

- 它会把生产依赖从 Python 包扩大为完整办公套件及其平台安装、升级和安全维护。
- 官方文档明确指出 LibreOffice 需要对用户 profile 目录具有写权限；并发 worker 需要为每个转换任务或进程隔离 `UserInstallation`，否则会引入 profile 锁和共享状态。[LibreOffice：Starting with parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)
- 转换结果仍依赖 LibreOffice 所在主机的字体；它不能消除跨平台字体差异。
- 启动外部进程增加超时、僵尸进程、临时文件清理、宏与不可信文档隔离等运维面。
- 生产 PDF 已可由 ReportLab 直接生成，没有必要先生成 DOCX 再通过第二个排版引擎转换。

LibreOffice 适合作为可选 QA 工具：

1. CI 或开发环境安装固定版本的 LibreOffice。
2. 使用独立临时 profile 和独立输出目录，将测试 DOCX 转成 PDF。
3. 对 PDF 做页数、文本抽取、截图或人工视觉检查。
4. QA 失败不改变生产导出架构；它用来发现 DOCX 在真实办公套件中的兼容性问题。

LibreOffice 官方给出的 profile 隔离入口是 `-env:UserInstallation=file:///...`；该目录必须可写。[LibreOffice：Starting with parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

## 建议的模块边界

```text
ReportExportService
  parse(markdown) -> DocumentModel
  validate(model) -> warnings
  export_docx(model, template, font_policy) -> bytes
  export_pdf(model, stylesheet, embedded_fonts) -> bytes
```

导出服务的输入只包含最终 Markdown、报告元数据、来源清单和导出选项。它不接触 AO 工作流、GPTR 研究过程或模型配置。

建议输出元数据：

- MIME type、建议文件名和字节数
- 导出器及模板版本
- 字体资产版本
- 生成时间
- warnings，例如不支持节点、图片下载失败、缺失 glyph
- 最终 Markdown 内容哈希，便于证明不同格式来自同一报告

## 验收矩阵

每个受支持平台都应在 CI 或发布前环境执行：

| 类别 | Windows | Linux | macOS |
|---|---:|---:|---:|
| 生成 DOCX，无 Office/LibreOffice | 必须 | 必须 | 必须 |
| 用 `python-docx` 重新打开 DOCX | 必须 | 必须 | 必须 |
| 生成 PDF，无 Office/LibreOffice | 必须 | 必须 | 必须 |
| PDF 文本抽取包含中英文哨兵字符 | 必须 | 必须 | 必须 |
| PDF 字体已嵌入 | 必须 | 必须 | 必须 |
| 标题、列表、表格、链接、引用、图片 | 必须 | 必须 | 必须 |
| LibreOffice DOCX 视觉 QA | 可选 | 可选 | 可选 |

测试 fixture 至少应覆盖：

- 简体中文、英文、数字、货币和百分比
- 长 URL、可点击引用和文末参考文献
- 跨页表格、长列表和长标题
- 中英文混排的粗体与斜体
- 本地图片、受控远程图片失败和超大图片
- 不支持 Markdown 节点的 warning 行为

## 决策

生产路径采用 `python-docx + ReportLab` 两个直接渲染器，共享一个规范化文档模型和一套版本化样式/字体资产。Microsoft Office 与 LibreOffice 都不是运行时依赖。LibreOffice 仅用于可选的 DOCX 视觉兼容性测试。
