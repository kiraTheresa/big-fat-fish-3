# 肥鱼指导手册 RAG Demo

用一条手册验证「梁文锋是你爹吗」在不同群聊场景下是否会把手册原文加入 DeepSeek 请求。脚本复用项目的 `buildChatRequest` 和默认人设，用模拟群和发言者组装纯文本请求。向量计算在本地完成，DeepSeek 请求只写入 JSON。

首次准备需要 Node.js、项目依赖和本地 ONNX 模型文件。从仓库根目录执行下面的命令。模型权重约 23 MB，依赖和模型文件准备好后可离线重跑。

```sh
npm ci --prefix demos/handbook-rag --cache "$PWD/demos/handbook-rag/tmp/npm-cache"
(
  set -e
  cd demos/handbook-rag
  mkdir -p tmp/model/onnx
  model_url=https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/75c43b069aac4d136ba6bc1122f995fedcfd2781
  for file in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
    curl -fLsS --retry 2 "$model_url/$file" -o "tmp/model/$file"
  done
)
```

每次运行都会重新计算一条手册向量和两条查询向量。模拟群 `10002` 没有适用条目，会在查询编码前退出检索。

```sh
TZ=Asia/Shanghai CHAT_STREAM=false node demos/handbook-rag/demo.mjs
```

- `tmp/index.json` 保存手册原文、群作用域、模型版本和 512 维向量。
- `tmp/results.json` 保存三个场景的相似度、命中原文和完整的 `POST /chat/completions` 请求体。手册原文只出现在命中场景的 `messages[0].content` 末尾。

脚本会断言三个场景的命中结果和手册注入位置。0.60 是按本例的样本分数选定的阈值。增加手册条目或换模型后，需要用更多正反问法重新校准。 [模型说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)
