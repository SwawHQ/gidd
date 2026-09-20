1. `.agents/skills/gidd` 是当前项目的核心，和发布的技能，当然，当前项目也能直接使用它，这样方便调试
2. 修订功能注意检查 help 文档，gidd.pre.ensure 和 gidd.link 的在 `.agents/skills/gidd/references`
3. dev 的在 `dev/help`
4. help 文档中不必巨细无遗，能用注释在代码中写明的，就不要放到 help 文档，例如 xxx 命令参数不能为空，必须满足...，代码层面能检查的就直接做好，保持 help 简洁顺畅是重要的产品体验
5. help 文档格式保持：

   ```text
   <command> <arguments>  #<description>
   <command> <arguments>  #<description>
   ```

   尽量考虑用户打印时，每条命令 + 说明是能只占据一行、且排版对齐、美观。尽量减少这种：

   ```text
   <command>  #<description>
   #<description>
   ```
