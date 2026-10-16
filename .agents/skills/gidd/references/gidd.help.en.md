GIDD (Windows x64 / PowerShell 5.1)
  gidd help en                                              #Show English help
  gidd help zh                                              #Show Chinese help
  gidd lang.set <zh|en>                                     #Set the global default output language
  gidd lang.clear                                           #Clear the language preference; use the system language
  gidd doctor                                               #Check tools, the repository, the account and remote access
  gidd doctor --offline                                     #Check local setup only; supports --lang zh|en
  gidd policy.deliveries                                    #List all delivery modes; supports --lang zh|en
  gidd policy.list 00                                       #List authorization policies in delivery mode 00
  gidd policy 00/00                                         #Show authorization policy 00/00
  gidd policy.history                                       #Show authorization policy selections; -v adds times
  gidd policy.issue 00/00                                   #Print the authorization policy's Issue template
  gidd gh.auth                                              #Log in and select this repository's GitHub account (interactive)
  gidd issue --file <file> --policy <policy>                #Create an Issue and task from Markdown; prepare its workspace
  gidd <issue-number> --policy <policy>                     #Register an existing Issue; prepare or resume its workspace
  gidd <issue-number>                                       #Show local task and workspace state
  gidd <issue-number>.policy                                #Show the task's authorization policy; supports --lang zh|en
  gidd <issue-number>.policy.set <policy>                   #Change the task's authorization policy
  gidd <issue-number>.push                                  #Push the working or target branch by delivery mode
  gidd <issue-number>.merge [--squash] [--message <title>]  #Merge locally or through a PR by mode; default: merge
  gidd <issue-number>.merge --rebase                        #Use rebase in delivery mode 02.pr-merge only
  gidd <issue-number>.target-sync                           #Sync the local target branch after the PR merges
  gidd <issue-number>.close-issue                           #Verify delivery for the mode, then close the Issue
  gidd <issue-number>.cleanup                               #Remove task records and any working branch; release the workspace
  gidd worktree.list                                        #List other worktrees of the target repository and their states
  gidd worktree.show <path>                                 #Show the workspace's associated task and Git state
  gidd worktree.remove <path>                               #Remove a released workspace and its registration

  gidd git [args...]                                        #Run the prepared Git
  gidd gh [args...]                                         #Run the prepared GitHub CLI
  gidd bun [args...]                                        #Run the prepared Bun
  gidd node [args...]                                       #Run the prepared Node.js
  gidd git remote add for.swaw.gidd <url>                   #Add a dedicated GIDD remote
