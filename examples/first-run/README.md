# 咔嚓 90 秒首跑

执行：

```bash
node examples/first-run/demo.mjs
```

脚本在临时目录生成 3 秒本地素材，创建 Timeline IR，通过 Command Journal 写入两个最终渲染键帧和一个人工复看标记，执行 undo/redo、Timeline 校验与 FFmpeg 预览渲染。输出中的 `demo-summary.json` 记录路径、SHA、耗时和边界。

`withinActivationTarget` 只表示离线环境中“首次可验证编辑”的激活耗时，不表示创意质量验收或正式发布完成。
