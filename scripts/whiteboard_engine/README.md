# 白板手绘动画引擎（vendored）

本目录是 [`geeklee/srt-whiteboard-animation`](https://github.com/geeklee/srt-whiteboard-animation)
的 vendored 副本，作为咔嚓 `whiteboard` 能力的渲染引擎。上游以 MIT 许可发布，
本副本遵守同一许可（见 [LICENSE](LICENSE)，版权归上游作者所有）。

- 来源：https://github.com/geeklee/srt-whiteboard-animation
- 版本锚点：`main` @ `696a7243c0e6`（2026-07-27）
- 许可：MIT（原样保留于本目录 LICENSE）

## 文件清单

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `stream_render.py` | 原样 | 流式笔迹渲染核心（网格/骨架笔迹、轮廓扫描上色、H.264 转码） |
| `render_stream_whiteboard.py` | 补丁 | 整合渲染入口：线稿 + 标注 → 白板动画 MP4，末行打印 `OUTPUT=` |
| `parse_srt.py` | 原样 | SRT 解析 + 分镜建议（纯标准库，无第三方依赖） |
| `merge_scenes.py` | 原样 | 多幕合并（ffmpeg concat 优先，PyAV 回退） |
| `annotation_preview.py` | 补丁 | 标注检查图（区域/顺序/手部路径叠加） |
| `prepare_env.py` | 补丁 | Python 虚拟环境与依赖引导 |
| `preview.html` | 原样 | 本地标注编辑台（浏览器直接打开，只读本机文件，无网络请求） |
| `LICENSE` | 原样 | 上游 MIT 许可 |

手部素材 `drawing-hand.png` vendored 到仓库 `assets/whiteboard/drawing-hand.png`。

## 本地补丁清单

所有改动都保持上游算法不变：

1. `prepare_env.py`
   - 虚拟环境默认建在引擎目录内（`scripts/whiteboard_engine/.venv`），
     可用 `KACHA_WHITEBOARD_VENV` 覆盖；上游固定建在 skill 根目录，会污染
     咔嚓安装根。
   - OpenCV 使用 `opencv-python-headless`：渲染只用 imread/imwrite/VideoWriter，
     不需要 GUI 会话（CI 无显示器环境必需）。
   - 增加 Python >= 3.10 的显式版本检查。
2. `annotation_preview.py`（由上游 `render_annotation_preview.py` 改名）
   - 字体可移植：上游硬编码 `C:/Windows/Fonts/msyh.ttc`，macOS/Linux 直接崩溃。
     现按 `--font` 参数 → `KACHA_WHITEBOARD_PREVIEW_FONT` 环境变量 → 常见平台
     字体 → PIL 默认字体的顺序解析。
   - `label` / `reveal.direction` / `handPath` 缺失时跳过对应绘制并提示，
     不再 KeyError（这些是创作元数据，validate 允许缺失）。
   - 参数解析改用 argparse（上游是位置参数约定）。
3. `render_stream_whiteboard.py`
   - `DEFAULT_HAND` 指向咔嚓仓库的 `assets/whiteboard/drawing-hand.png`，
     可用 `KACHA_WHITEBOARD_HAND` 覆盖；上游相对路径在 vendored 目录结构下失效。
   - 修复上游 `_lay_ink` 调用点多余实参：空墨迹区域（区域在空白纸面或被
     protectedRegions/后续区域完全遮蔽）必然 TypeError 崩溃；现在跳过并打印
     警告。
   - 手部素材高度按输出高度等比缩放（上游固定按 1080p 的 493px，小尺寸输出
     时手部会盖住大半画面）。

## 上游同步

升级引擎时：核对上游提交，重新应用上述三个补丁，更新本文件中的版本锚点，
并用咔嚓的 `node scripts/kacha.mjs whiteboard` 命令与 `tests/run_tests.mjs
--suite whiteboard` 做真实渲染回归。
