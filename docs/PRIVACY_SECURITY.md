# 隐私与安全

## 默认边界

咔嚓默认在本机处理，不上传、不发布、不购买授权、不发起付费生成。任何外部动作都必须来自当前任务的明确授权。

## 不应进入 Git 的内容

- API key、token、cookie、密码和 OAuth 凭据；
- `.env`、`media.env`、shell 私有配置；
- SSH、PGP、TLS 私钥或证书私钥；
- 原始视频、录音、人物照片、字幕草稿和未公开文稿；`assets/sfx/manifest.json` 明确列出的 12 个作者原创授权音效除外；
- 客户、受访者或项目内部信息；
- 模型权重、下载缓存、渲染输出和能力快照；
- 包含本机用户名的绝对路径；
- 第三方付费素材、字体、模板或许可文件；
- 平台任务 ID、账单详情或内部接口响应。

## 凭据使用

脚本支持以下环境变量名：

- `MINIMAX_API_KEY`
- `PIXABAY_API_KEY`
- `PEXELS_API_KEY`
- `KACHA_DEMUCS_BIN`
- `KACHA_SFX_LIBRARY`
- `XDG_DATA_HOME`

前三项 API key 是敏感凭据；后三项是本机路径配置。真实 key 也可放在权限为
`0600` 的 `~/.config/kacha/secrets.json`。MiniMax 可继续使用 mmx 自身的
OAuth/API-key 凭证库。

`kacha.config.json` 和 `~/.config/kacha/config.json` 只允许保存非敏感参数、
环境变量名称和默认剪辑要求；配置校验器拒绝把授权字段放进默认参数。密钥值
只注入需要它的子进程，不写入命令行、agent packet、QC、缓存或日志。
自动发现的项目配置不能设置 `providers` 或 `tools`，避免项目文件改变用户级
凭证入口、MiniMax 地址或本机可执行程序；这些项只接受用户配置或显式配置。

不要把真实值写入仓库。推荐使用本机密码管理器、CI secret store、权限受控的
shell 环境或 `secrets.json`。

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
