GIDD (Windows x64 / PowerShell 5.1)

  gidd.link help zh           #显示中文帮助
  gidd.link help en           #Show English help
  gidd.link doctor            #Run checks enabled in references/doctor.toml (includes network checks)
  gidd.link doctor --offline  #Check local tools, configuration and repository without network requests
  gidd.link doctor --lang en  #Choose zh|en; default: GIDD_LANG, then system locale; accepts --offline
  gidd.link set.show          #Print config.toml as-is (TOML)
  gidd.link set <key> <value> #Set a field in config.toml
  gidd.link set spec.current 00/00        #Select the current spec
  gidd.link set repo.remote.account bornwhy #(Example) Set repo.remote.account to bornwhy
  gidd.link set repo.remote.name origin #(Example) Record the remote name used for the local repository
  gidd.link set repo.remote.url <url>   #Record the remote URL used for the local repository
  gidd.link set git.credential.mode gh  #(Example) Required; how to supply credentials for the remote URL: gh|inherit
  gidd.link set git.user.mode managed   #Required: managed uses configured name/email; inherit uses Git identity
  gidd.link set git.user.name <user>    #Required in managed mode; remove with clear in inherit mode; sets git user.name
  gidd.link set git.user.email <email>  #Required in managed; remove with clear in inherit mode; sets git user.email
  gidd.link clear <key>             #Remove a field from config.toml
  gidd.link clear git.user.name     #(Example) Remove git.user.name (inherit mode also requires removing git.user.email)
  gidd.link spec.modes                    #List mode directory names, descriptions and available spec counts
  gidd.link spec.list 00                  #List mode 00 specs and authorizations
  gidd.link spec 00/00                    #Generate the selected spec prompt
  gidd.link spec.current                  #Generate the current spec prompt
  gidd.link spec.current --lang zh        #Choose zh|en; all spec commands support --lang
  gidd.link spec.issue 00/00              #Print the selected spec's Issue template
  gidd.link spec.issue.current            #Print the current spec's Issue template
  gidd.link .gh.auth               #Check the configured account's credentials; start interactive login if missing (credentials managed by gh)
  gidd.link .gh <native gh args>   #Forward with the configured account, repository and Git; disable common interaction
  gidd.link .git <native git args> #Forward with the configured identity and HTTPS credentials; disable common interaction

Wrappers preserve piped input and fail when an editor or credential prompt is needed. See execution.md for custom programs.
  $env:GIDD_EXEC_TIMEOUT_MS=600000 #Optional: limit forwarded commands to 10 minutes; default unlimited, timeout exits 124
