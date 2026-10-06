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
  gidd.link workflow.workspace <issue>                  #Prepare from the current spec and target checkout branch
  gidd.link workflow.workspace --resume <issue>         #Inspect local records and Git state offline
  gidd.link workflow.push <issue>                       #Push the branch selected by delivery mode
  gidd.link workflow.merge <issue> [--squash|--rebase]  #Local or PR merge; defaults to merge; --message sets the title
  gidd.link workflow.target-sync <issue>                #Verify PR delivery and fast-forward the target
  gidd.link workflow.close-issue <issue>                #Verify delivery and close the Issue; link its PR when applicable
  gidd.link workflow.cleanup <issue>                    #Verify delivery and clean local resources
  gidd.link worktree.list                               #Summarize other worktrees, branches and state
  gidd.link worktree.show <path>                        #Show workflow context and actual Git state
  gidd.link worktree.remove <path>                      #Remove a released worktree without leftover files
  gidd.link .gh.auth               #Check the configured account's credentials; start interactive login if missing (credentials managed by gh)
  gidd.link .gh <native gh args>   #Forward with entry account, repository and Git; disable common interaction
  gidd.link .git <native git args> #Forward with entry identity and HTTPS credentials; disable common interaction
