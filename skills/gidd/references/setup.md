# 初始化入口

当前仅实现 Windows 基础诊断，使用方法和输出解释见 [doctor.md](doctor.md)。Agent 应先解释缺项，再执行用户已授权且确已实现的初始化操作。

自动下载、配置写入、登录及完整 GIDD 开发流程尚未实现，不得把 doctor 的 `local_ready` 当作初始化完成。
