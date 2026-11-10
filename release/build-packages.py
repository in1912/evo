# -*- coding: utf-8 -*-
# 三端发布打包：Windows / macOS / Docker。
# 模型一律不内嵌；每包含《模型下载说明.md》+ 平台《安装说明》。
# 用法：python release/build-packages.py [windows|macos|docker|all]
import os, sys, zipfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # G:\video
SRC = os.path.join(ROOT, 'release', 'src')
OUT = os.path.join(ROOT, 'release')
VER = '1.0.43'

SKIP_DIRS = {'__pycache__', '.git', '.github', '.ci', '.cache', '.ipynb_checkpoints', '.pytest_cache', '.ruff_cache', '.vscode', '.idea'}
SKIP_EXTS = {'.pyc', '.pyo'}
WEIGHT_EXTS = {'.safetensors', '.gguf', '.pt', '.pth', '.ckpt', '.bin', '.onnx'}

SKIPPED = []

def add_file(z, full, arc, exec_bit=False):
    try:
        with open(full, 'rb') as f:
            data = f.read()
    except OSError as e:
        # 运行中的 ComfyUI/数据库会锁个别文件：跳过并记录，不中断打包
        SKIPPED.append((arc, str(e)[:60]))
        return
    zi = zipfile.ZipInfo(arc, date_time=time.localtime(os.path.getmtime(full))[:6])
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = (0o755 if exec_bit else 0o644) << 16
    z.writestr(zi, data)

def add_str(z, arc, content=''):
    zi = zipfile.ZipInfo(arc + '/' if not arc.endswith('/') else arc)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = (0o755 << 16) if arc.endswith('.command') or arc.endswith('.sh') else (0o644 << 16)
    z.writestr(zi, content)

def walk_add(z, base, prefix='', win_root=False):
    """把 base 目录加进 zip（arc 前缀 prefix）。win_root=True 时套用 Windows 包特有排除规则。"""
    n = 0
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel = os.path.relpath(root, base)
        arcroot = prefix if rel == '.' else prefix + '/' + rel.replace('\\', '/')
        for fn in sorted(files):
            full = os.path.join(root, fn)
            arc = arcroot + '/' + fn
            ext = os.path.splitext(fn)[1].lower()
            if ext in SKIP_EXTS:
                continue
            if win_root:
                rl = arc  # 相对包根
                if rl.startswith('ComfyUI/models/') and ext in WEIGHT_EXTS:
                    continue  # 模型不内嵌（占位文件 put_xxx_here 保留）
                if rl.startswith('ComfyUI/models/hub/'):
                    continue
                if rl.startswith('ComfyUI/output/') and rl != 'ComfyUI/output/':
                    continue
                if rl.startswith('ComfyUI/temp/') and rl != 'ComfyUI/temp/':
                    continue
                if rl == 'ComfyUI/extra_model_paths.yaml':
                    continue  # 旧机绝对路径，勿带
            add_file(z, full, arc)
            n += 1
    return n

def build_windows():
    name = f'EvolveShot_v{VER}_Windows.zip'
    print('== Windows 包 ==', name)
    t0 = time.time(); count = 0
    with zipfile.ZipFile(os.path.join(OUT, name), 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        # 重型运行时 + 应用
        for d in ['ComfyUI', 'python_embeded', 'cuda-home', 'py312', 'server', 'web', 'node_modules', 'work', 'res']:
            c = walk_add(z, os.path.join(ROOT, d), prefix=d, win_root=(d == 'ComfyUI'))
            count += c; print(f'   {d:16} {c:6} files')
        for f in ['package.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'start.bat', 'start-model.bat']:
            full = os.path.join(ROOT, f)
            if os.path.exists(full): add_file(z, full, f); count += 1
        # 说明文件
        for f in ['安装说明-Windows.md', '模型下载说明.md']:
            add_file(z, os.path.join(SRC, 'windows', f), f); count += 1
        # 空目录占位（start-model.bat 要往 Logs\relay.log 重定向）
        add_str(z, 'Logs'); add_str(z, 'ComfyUI/output'); add_str(z, 'ComfyUI/temp')
    sz = os.path.getsize(os.path.join(OUT, name))
    print(f'   共 {count} 文件，{sz/1073741824:.2f}GB，{time.time()-t0:.0f}s')
    return name

def build_macos():
    name = f'EvolveShot_v{VER}_macOS.zip'
    print('== macOS 包 ==', name)
    t0 = time.time(); count = 0
    with zipfile.ZipFile(os.path.join(OUT, name), 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for d in ['server', 'web', 'node_modules', 'work']:
            count += walk_add(z, os.path.join(ROOT, d), prefix=d)
        # res：高清修复脚本+权重（concat 里是 Windows 安装包，mac 不带）
        for root, dirs, files in os.walk(os.path.join(ROOT, 'res')):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and d != 'concat')
            rel = os.path.relpath(root, os.path.join(ROOT, 'res'))
            arcroot = 'res' if rel == '.' else 'res/' + rel.replace('\\', '/')
            for fn in sorted(files):
                if os.path.splitext(fn)[1].lower() in SKIP_EXTS: continue
                add_file(z, os.path.join(root, fn), arcroot + '/' + fn); count += 1
        for f in ['package.json', 'README.md']:
            add_file(z, os.path.join(ROOT, f), f); count += 1
        for f in ['安装说明-macOS.md', '模型下载说明.md']:
            add_file(z, os.path.join(SRC, 'macos', f), f); count += 1
        add_file(z, os.path.join(SRC, 'macos', 'start-mac.command'), 'start-mac.command', exec_bit=True); count += 1
    print(f'   共 {count} 文件，{os.path.getsize(os.path.join(OUT, name))/1048576:.1f}MB，{time.time()-t0:.0f}s')
    return name

def build_docker():
    name = f'EvolveShot_v{VER}_Docker.zip'
    print('== Docker 包 ==', name)
    t0 = time.time(); count = 0
    with zipfile.ZipFile(os.path.join(OUT, name), 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for d in ['server', 'web', 'node_modules']:
            count += walk_add(z, os.path.join(ROOT, d), prefix=d)
        for f in ['package.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.dockerignore']:
            add_file(z, os.path.join(ROOT, f), f); count += 1
        for f in ['安装说明-Docker.md', '模型下载说明.md']:
            add_file(z, os.path.join(SRC, 'docker', f), f); count += 1
    print(f'   共 {count} 文件，{os.path.getsize(os.path.join(OUT, name))/1048576:.1f}MB，{time.time()-t0:.0f}s')
    return name

if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    done = []
    if which in ('windows', 'all'): done.append(build_windows())
    if which in ('macos', 'all'): done.append(build_macos())
    if which in ('docker', 'all'): done.append(build_docker())
    if SKIPPED:
        print(f'-- 跳过 {len(SKIPPED)} 个不可读文件（多为运行中锁定/缓存）:')
        for arc, err in SKIPPED[:40]:
            print('   SKIP', arc, '|', err)
    print('DONE:', ', '.join(done))
