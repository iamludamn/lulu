#!/usr/bin/env python3
"""项目密钥入口：解密到内存后注入命令；不创建明文文件。"""
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys


def main():
    args = sys.argv[1:]
    check = bool(args and args[0] == 'check')
    if check:
        args.pop(0)
    if args[:1] == ['--']:
        args.pop(0)
    if not check and not args:
        sys.exit('用法：python3 scripts/project-secrets.py [check | -- <命令> ...]')
    root = Path(__file__).resolve().parent.parent
    source = root / 'secrets.dev.enc.json'
    key = Path.home() / '.config/agent-home/age-key.txt'
    env = os.environ.copy()
    env['SOPS_AGE_KEY_FILE'] = str(key)
    try:
        sops = shutil.which('sops') or str(Path.home() / '.local/bin/sops')
        result = subprocess.run([sops, 'decrypt', '--input-type', 'json', '--output-type', 'json', str(source)],
                                env=env, capture_output=True, check=True)
        secrets = json.loads(result.stdout)
        if not isinstance(secrets, dict) or not all(isinstance(k, str) and isinstance(v, str) and '\0' not in k + v and '=' not in k for k, v in secrets.items()):
            raise ValueError('invalid environment')
    except (OSError, subprocess.CalledProcessError, ValueError):
        sys.exit('密钥加载失败：检查 sops、加密文件和本机 age 私钥。未输出解密内容。')
    if check:
        print(f'解密检查通过：{len(secrets)} 个变量；未输出值。')
        return
    child = {**secrets, **os.environ}
    try:
        os.execvpe(args[0], args, child)
    except OSError:
        sys.exit('无法启动指定命令。')


if __name__ == '__main__':
    main()
