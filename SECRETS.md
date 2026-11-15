# 开发密钥

配置存放在 `secrets.dev.enc.json`（SOPS + age 密文），可随 Git 同步。日常运行不访问 1Password。

运行：`python3 scripts/project-secrets.py -- <命令> ...`

验证：`python3 scripts/project-secrets.py check`

两台开发机的私钥分别在 `~/.config/agent-home/age-key.txt`，不进入仓库；依赖 PATH 中的 sops。密文只包含迁移时在 1Password 找到的项目变量，缺失项见 agent-home 的 projects/secrets-migration.md。更改后需同步密文，不能把解密内容写入 Git。显式环境变量优先于加密配置。
