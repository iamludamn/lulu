#!/usr/bin/env python3
"""Diagnose T3's host-local iOS device claims without touching active sessions."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def find_agent_device():
    candidates = list((Path.home() / '.t3/tools/agent-device').glob('*/node_modules/.bin/agent-device'))
    def version(path):
        name = path.parents[2].name
        return tuple(int(x) for x in re.findall(r'\d+', name))
    candidates = [p for p in candidates if p.is_file() and os.access(p, os.X_OK)]
    if candidates:
        return str(max(candidates, key=version))
    return shutil.which('agent-device')


def run_json(binary, action, udid=None, stale=False):
    command = [binary, 'device', action, '--platform', 'ios', '--json']
    if udid:
        command += ['--udid', udid]
    if stale:
        command.append('--stale')
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError('agent-device 未返回有效 JSON，请检查其版本和运行环境。')
    if result.returncode or payload.get('success') is not True:
        raise RuntimeError('agent-device 执行失败；请直接运行 device status 检查具体错误。')
    data = payload.get('data')
    if not isinstance(data, dict):
        raise RuntimeError('agent-device 返回的数据格式不符合预期。')
    return data


def describe(claim):
    device = claim.get('device') or {}
    owner = claim.get('owner') or {}
    print(f"  设备：{device.get('name', '未知')}  {device.get('id', claim.get('deviceKey', '未知'))}")
    print(f"  分类：{claim.get('classification', '未知')}")
    for label, key in [('会话', 'session'), ('工作区', 'workspace'), ('进程 PID', 'pid')]:
        if owner.get(key) is not None:
            print(f'  {label}：{owner[key]}')


def main():
    parser = argparse.ArgumentParser(description='检查 T3 iOS 设备占用；默认只读。')
    parser.add_argument('--udid', help='只检查指定的模拟器 UDID')
    parser.add_argument('--release-stale', action='store_true', help='只对指定 UDID 请求官方安全清理已证实失效的占用')
    parser.add_argument('--agent-device', help='指定 agent-device 可执行文件')
    args = parser.parse_args()
    if args.release_stale and not args.udid:
        parser.error('--release-stale 必须同时指定 --udid，避免影响其他设备')
    if args.udid and not re.fullmatch(r'[A-Za-z0-9-]+', args.udid):
        parser.error('UDID 只能包含字母、数字和连字符')
    binary = args.agent_device or find_agent_device()
    if not binary:
        print('找不到 agent-device；请检查 T3 安装，或使用 --agent-device 指定路径。', file=sys.stderr)
        return 2
    try:
        active = run_json(binary, 'status', args.udid)
        stale = run_json(binary, 'status', args.udid, stale=True)
        if not isinstance(active.get('claims'), list) or not isinstance(stale.get('claims'), list):
            raise RuntimeError('agent-device 的占用列表格式不符合预期。')
        print(f'检查工具：{binary}')
        if not active['claims'] and not stale['claims']:
            print('没有发现匹配的本机 iOS 设备占用记录。')
            print('若 T3 仍不可用，可能是设备工具未连接或其他问题；此脚本无法验证 T3 工具连接。')
            return 0
        if active['claims']:
            print('\n正在使用或状态不确定的占用：')
            for claim in active['claims']:
                describe(claim)
            print('请回到对应工作区关闭占用设备的会话；不要删除占用文件或强制结束进程。')
        if stale['claims']:
            print('\nagent-device 判定为失效的占用：')
            for claim in stale['claims']:
                describe(claim)
            if not args.release_stale:
                print('如需尝试安全清理，请使用 --udid <设备 UDID> --release-stale 重新运行。')
        if args.release_stale:
            if not stale['claims']:
                print('没有可请求清理的失效占用；未执行清理。')
            else:
                outcome = run_json(binary, 'release', args.udid, stale=True)
                for key, label in [('released', '已释放'), ('retained', '保留'), ('refused', '拒绝'), ('changed', '状态已变化')]:
                    entries = outcome.get(key)
                    if not isinstance(entries, list):
                        raise RuntimeError('清理结果格式不符合预期；请重新检查设备状态。')
                    print(f'{label}：{len(entries)}')
                if any(outcome[k] for k in ('retained', 'refused', 'changed')):
                    print('部分记录未清理；请重新检查状态。')
                    return 1
        return 0
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
        print(f'检查未完成：{exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
