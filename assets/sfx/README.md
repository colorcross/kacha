# 原创音效库

本目录包含 12 个由行者大灰原创、可随“咔嚓”分发的音效。

- `original/`：原始 MP3；
- `ready/`：48 kHz 双声道 WAV 工作副本；
- `manifest.json`：标题、用途、时长、相对路径与 SHA-256；
- `LICENSE.md`：音频资产许可。

使用前先精确验证：

```bash
node scripts/validate_sfx_library.mjs \
  assets/sfx/manifest.json \
  --title "单击键盘" \
  --require-public-distribution
```

库存网站素材不在本目录内，也不会随仓库分发。
