<div align="center">

<img alt="inkwright" src="../media/hero-light.svg" width="480">

**像纸一样书写，与任何 AI 一起思考，并用墨迹回答你的手写笔记本。**<br>
本地优先 · 自带模型（或完全不用）· 开源 · 不需要我们的任何服务器

[打开应用](https://dev-null-k2.github.io/inkwright/app/) · [下载 Android 版](https://github.com/dev-null-k2/inkwright/releases/latest) · [English](../../README.md)

</div>

## 为什么做它

纸仍然是最好的思考工具。现有的笔记应用，要么写起来像纸却什么都不懂，要么什么都懂写起来却像填表。而“侧边栏 AI”为了回答一个关于笔记的问题，就把整本笔记发到别人的服务器上。

Inkwright 从笔开始：墨迹在下一帧之前就出现在笔尖下，涂抹即可擦除，能听到笔尖划过纸面的声音，在 Android 上还能感受到纸的纹理。然后它为这一页赋予思考：一个能读懂你的手写、把它与你写过的一切联系起来、检查前后是否矛盾、并用明显不同的“AI 墨水”在页面上回答你的智能体。笔记以普通文件的形式保存在你自己的设备和存储中；AI 做的每一件事都可见、有出处、可撤销。

## 功能

- **书写**：低延迟墨迹（Android 原生笔尖绘制）、纸张声音与触感、涂抹擦除（580 个测试用例中识别 99.6% 的涂抹，从未误删正常笔迹）、钢笔/书法笔/铅笔/荧光笔、PDF 填写与签名。
- **思考**：支持 OpenAI、Claude、Gemini、Ollama 等任何模型，或使用设备上的本地模型（数据不出设备）。圈选问题，AI 用手写体在旁边作答。画出方框和箭头即可“运行”流程。课堂录音在设备上转写，点按笔迹即可回放当时的声音。
- **记忆**：自动编译的个人 Wiki，每句话标注“摘录/推断/存疑”并指向原文位置；矛盾检查；FSRS 记忆卡片；双向链接、每日笔记、3D 知识图谱、Obsidian 导入导出。
- **信任**：每次 AI 调用都经过同一个检查点——按策略路由、隐私信息脱敏、上下文压缩（约节省 80% token）、费用统计、签名审计日志；可按笔记本设置“仅在本机”。
- **开发者**：`[[code:路径#函数]]` 把笔记链接到代码，代码变化时提示“漂移”；可验证的架构图；可执行的 Runbook；MCP、A2A、REST API（OpenAPI 3.1）、Webhooks、SDK 与命令行工具。

## 开始使用

```sh
git clone https://github.com/dev-null-k2/inkwright && cd inkwright
npm install
npm run dev
```

许可证：Apache-2.0。完整文档见英文 [README](../../README.md)。
