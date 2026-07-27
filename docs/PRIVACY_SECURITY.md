# 隐私与安全

## 默认边界

咔嚓咔嚓默认在本机处理，不上传、不发布、不购买授权、不发起付费生成。任何外部动作都必须来自当前任务的明确授权。

## 不应进入 Git 的内容

- API key、token、cookie、密码和 OAuth 凭据；
- `.env`、`media.env`、shell 私有配置；
- SSH、PGP、TLS 私钥或证书私钥；
- 原始视频、录音、人物照片、字幕草稿和未公开文稿；
- 客户、受访者或项目内部信息；
- 模型权重、下载缓存、渲染输出和能力快照；
- 包含本机用户名的绝对路径；
- 第三方付费素材、字体、模板或许可文件；
- 平台任务 ID、账单详情或内部接口响应。

## 凭据使用

脚本只读取环境变量名：

- `PIXABAY_API_KEY`
- `PEXELS_API_KEY`
- `KACHA_DEMUCS_BIN`
- `XDG_DATA_HOME`

前两项是敏感凭据；后两项是本机路径配置。不要把真实值写入仓库。推荐在本机密码管理器、CI secret store 或权限受控的 shell 环境中注入。

## 发布前检查

```bash
python3 scripts/scan_secrets.py
git status --short
git diff --cached --check
git grep -n "/Users/" -- . ':!docs/PRIVACY_SECURITY.md' || true
```

扫描器检查已跟踪和未忽略的候选文件，识别常见 token、私钥头、可疑 credential 赋值、敏感文件名和 macOS 用户绝对路径。它只能降低风险，不能证明零泄漏。

还应人工确认：

1. `git status --short` 中每个文件都应公开；
2. `examples/` 只包含虚构数据和占位哈希；
3. 没有真实媒体、日志、响应体或截图；
4. 没有复制本机配置目录；
5. 许可证允许公开所有新增资产。

## 如果已经误提交

1. 立即撤销或轮换凭据，不要只删除文件；
2. 停止继续推送；
3. 使用适当工具清理 Git 历史；
4. 通知仓库维护者和受影响平台；
5. 在确认旧凭据失效后再恢复发布。

公开仓库中的历史提交可能已被克隆或缓存，单纯追加一次“删除密钥”的 commit 不足以恢复安全。
