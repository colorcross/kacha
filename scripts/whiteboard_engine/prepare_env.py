#!/usr/bin/env python3
"""
白板手绘动画引擎 - 环境引导脚本（咔嚓 vendored 版）

职责：
  1. 建立隔离的 Python 虚拟环境（已存在则复用）
  2. 核对运行所需的第三方库是否可导入
  3. 按已核验的锁定版本安装或升级库
  4. 末行打印 ENV_PY=<解释器路径>，供上层调用方捕获

与上游的差异（见 README.md 补丁清单）：
  - 虚拟环境位置：默认建在用户数据目录，按依赖锁摘要隔离，
    可用环境变量 KACHA_WHITEBOARD_VENV 覆盖；上游固定建在 skill 根目录。
  - opencv 使用 headless 变体：咔嚓/CI 环境无 GUI 会话，渲染用不到 cv2 高层窗口。

用法：
  python prepare_env.py          # 建环境 + 对齐锁定依赖，输出 ENV_PY
  python prepare_env.py --check  # 仅探测，缺失或版本不符就以非零码退出
"""
from __future__ import annotations

import os
import json
import hashlib
from contextlib import contextmanager
import subprocess
import sys
import venv
import time
from pathlib import Path

# 引擎目录 = 本脚本所在目录（咔嚓：scripts/whiteboard_engine）
ENGINE_ROOT = Path(__file__).resolve().parent
LOCK_FILES = [ENGINE_ROOT.parent / "requirements-render.txt", ENGINE_ROOT / "requirements.txt"]
LOCK_DIGEST = hashlib.sha256(b"".join(file.read_bytes() for file in LOCK_FILES)).hexdigest()[:16]
DATA_ROOT = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
VENV_ROOT = Path(os.environ.get("KACHA_WHITEBOARD_VENV") or os.environ.get("KACHA_RENDER_VENV")
                 or (DATA_ROOT / "kacha" / "render-envs" / LOCK_DIGEST)).resolve()

# 解释器导入名 -> pip 安装名
DEPS: dict[str, str] = {
    "cv2": "opencv-python-headless",
    "numpy": "numpy",
    "av": "av",  # PyAV：纯 pip 安装的 H.264 编码，无需系统 ffmpeg
    "fontTools": "fonttools",
    "PIL": "Pillow",  # annotation_preview.py 画区域编号预览图（含中文标签）
}


REQUIREMENTS = ENGINE_ROOT / "requirements.txt"

def locked_versions() -> dict[str, str]:
    versions = {}
    for file in LOCK_FILES:
        for line in file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith(("#", "-r")):
                name, version = line.split("==", 1)
                versions[name.lower()] = version
    return versions


def installed_versions(py: Path) -> dict[str, str]:
    probe = subprocess.run([str(py), "-c",
        "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name'].lower():d.version for d in m.distributions()}))"],
        capture_output=True, text=True)
    if probe.returncode != 0:
        return {}
    return json.loads(probe.stdout)


def interpreter_path() -> Path:
    """虚拟环境里的 python 可执行文件位置（跨平台）。"""
    if sys.platform.startswith("win"):
        return VENV_ROOT / "Scripts" / "python.exe"
    return VENV_ROOT / "bin" / "python"


def ensure_venv(check_only: bool) -> Path:
    py = interpreter_path()
    if VENV_ROOT.exists() and py.exists():
        print(f"[ok] 复用现有虚拟环境: {VENV_ROOT}")
        return py

    if check_only:
        print(f"[err] 虚拟环境尚未建立: {VENV_ROOT}")
        sys.exit(1)

    print(f"[..] 建立虚拟环境: {VENV_ROOT}")
    venv.create(str(VENV_ROOT), with_pip=True)
    print("[ok] 虚拟环境就绪")
    return py


def can_import(py: Path, import_name: str) -> bool:
    probe = subprocess.run(
        [str(py), "-c", f"import {import_name}"],
        capture_output=True,
    )
    return probe.returncode == 0


def install(py: Path, packages: list[str]) -> bool:
    if not packages:
        return True
    print(f"[..] 安装依赖: {', '.join(packages)}")
    res = subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "--upgrade", "-r", str(REQUIREMENTS)],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(f"[err] 安装失败:\n{res.stderr}")
        return False
    print("[ok] 依赖安装完成")
    return True


@contextmanager
def preparation_lock():
    """Serialize installers across repositories/agents sharing the same lock set."""
    VENV_ROOT.parent.mkdir(parents=True, exist_ok=True)
    with (VENV_ROOT.parent / (VENV_ROOT.name + ".lock")).open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, 2)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            def acquire():
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deadline = time.monotonic() + 600
        while True:
            try:
                acquire()
                break
            except (BlockingIOError, PermissionError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("其他进程仍在准备同一渲染环境；稍后重试")
                time.sleep(0.2)
        yield
        # Closing the handle also releases the OS lock on errors/interruption.


def prepare(check_only: bool) -> None:
    if sys.version_info < (3, 12):
        print(f"[err] 需要 Python >= 3.12，当前 {sys.version.split()[0]}")
        sys.exit(1)
    py = ensure_venv(check_only)
    actual_python = subprocess.run([str(py), "-c", "import sys; sys.exit(sys.version_info < (3,12))"])
    if actual_python.returncode:
        print("[err] 现有虚拟环境需要 Python >= 3.12；请指定新的 KACHA_RENDER_VENV 后重试")
        sys.exit(1)

    missing: list[str] = []
    expected, installed = locked_versions(), installed_versions(py)
    for import_name, pip_name in DEPS.items():
        version = expected[pip_name.lower()]
        if installed.get(pip_name.lower()) == version and can_import(py, import_name):
            print(f"[ok] {pip_name}=={version}")
        else:
            print(f"[update] {pip_name}: {installed.get(pip_name.lower(), 'missing')} -> {version}")
            missing.append(pip_name)

    if missing:
        if check_only:
            print(f"\n缺失或版本不符 {len(missing)} 个依赖: {', '.join(missing)}")
            sys.exit(1)
        (VENV_ROOT / ".kacha-ready").unlink(missing_ok=True)
        if not install(py, missing):
            sys.exit(1)

    versions = installed_versions(py)
    if any(versions.get(name) != version for name, version in expected.items()) or any(not can_import(py, name) for name in DEPS):
        print("[err] 安装后依赖版本或导入验证失败")
        sys.exit(1)
    check = subprocess.run([str(py), "-m", "pip", "check"], capture_output=True, text=True)
    if check.returncode:
        print(f"[err] 依赖冲突：{check.stdout}{check.stderr}")
        sys.exit(1)

    if not check_only:
        (VENV_ROOT / ".kacha-ready").write_text(LOCK_DIGEST + "\n")

    # 末行：供调用方捕获的约定输出
    print(f"\nENV_PY={py}")


if __name__ == "__main__":
    if "--check" in sys.argv:
        prepare(True)
    else:
        with preparation_lock():
            prepare(False)
