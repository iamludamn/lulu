# T3 iOS 设备占用排查

在仓库根目录执行：

```sh
python3 scripts/t3-ios-doctor.py
python3 scripts/t3-ios-doctor.py --udid <模拟器UDID>
```

脚本读取 `agent-device` 的本机设备所有权状态，显示设备、会话、工作区和占用分类。若会话仍存活或状态不确定，回到对应工作区关闭会话，再重新检查。线程是否结束不足以判断设备是否可安全释放。

若检查结果有失效记录，可针对单台设备请求安全清理：

```sh
python3 scripts/t3-ios-doctor.py --udid <模拟器UDID> --release-stale
```

清理由 `agent-device device release --stale` 完成；实际是否释放由该工具重新核验。脚本不会删除占用文件、关闭其他会话或直接杀进程。若状态变化、清理被拒绝或资源未清理完，重新检查并按结果处理。

脚本只检查本机所有权记录，不能判断 T3 的设备工具是否已连接，也不能保证从会话 ID 找到对应 thread。没有占用记录时，仍可能存在工具连接或其他问题。使用 `--agent-device <路径>` 可以选择特定版本。
