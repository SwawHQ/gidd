GIDD (Windows x64 / PowerShell 5.1)

  gidd.link help zh           #显示中文帮助
  gidd.link help en           #Show English help
  gidd.link doctor            #Check tools, repository and GitHub identity (includes network checks)
  gidd.link doctor --offline  #Check local tools, configuration and repository without network requests
  gidd.link set.show          #Show the current contents of config.toml
  gidd.link set <key> <value> #Set a field in config.toml
  gidd.link set spec.current issue-direct  #(Example) Set the current spec; list available specs: gidd.link spec.list
  gidd.link set repo.remote.account bornwhy #(Example) Set repo.remote.account to bornwhy
  gidd.link set repo.remote.name origin #(Example) Record the remote name used for the local repository
  gidd.link set repo.remote.url <url>   #Record the remote URL used for the local repository
  gidd.link set git.credential.mode gh  #(Example) Required; how to supply credentials for the remote URL: gh|inherit
  gidd.link set git.user.mode managed   #(Example) Required; how to set Git commit identity: managed|inherit
  gidd.link set git.user.name <user>    #Required in managed mode; remove with clear in inherit mode; sets git user.name
  gidd.link set git.user.email <email>  #Required in managed; remove with clear in inherit mode; sets git user.email
  gidd.link clear <key>             #Remove a field from config.toml
  gidd.link clear git.user.name     #(Example) Remove git.user.name (inherit mode also requires removing git.user.email)
  gidd.link spec.list               #List spec summaries; read full instructions: gidd.link spec.<name>
  gidd.link spec.current            #Print the current spec
  gidd.link spec.current --lang zh  #As above, with a specified language: zh|en; also applies below
  gidd.link spec.issue-direct       #Print the spec named issue-direct
  gidd.link spec.current.issue      #Print the GitHub Issue template required by the current spec
  gidd.link spec.issue-direct.issue #As above, for the issue-direct spec
  gidd.link .gh.auth               #Check the configured account's credentials; start interactive login if missing (credentials managed by gh)
  gidd.link .gh <native gh args>   #Supply the configured environment: account token/GH_HOST/GH_REPO/Git (priority < explicit arguments), then forward to gh
  gidd.link .git <native git args> #Supply the configured environment: identity/HTTPS credential helper (priority > .git/config, < arguments), then forward to git
