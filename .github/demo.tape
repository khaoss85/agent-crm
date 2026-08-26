# Accordo demo — scaffold, agent hits the gate, the workflow that stopped it.
# Rendered by `vhs demo.tape` from an empty directory. Everything is real:
# real npm package, real commands, real output.

Output demo.gif

Set Shell bash
Set FontSize 17
Set Width 1180
Set Height 640
Set Padding 24
Set TypingSpeed 40ms
Set Theme { "name": "accordo", "background": "#171912", "foreground": "#d8dcd0", "cursor": "#8cf39a", "black": "#171912", "red": "#ff6b69", "green": "#8cf39a", "yellow": "#f2cd5d", "blue": "#20b8d8", "magenta": "#7457ff", "cyan": "#20b8d8", "white": "#d8dcd0", "brightBlack": "#8f9d94", "brightRed": "#ff6b69", "brightGreen": "#8cf39a", "brightYellow": "#f2cd5d", "brightBlue": "#20b8d8", "brightMagenta": "#7457ff", "brightCyan": "#20b8d8", "brightWhite": "#f7f3e9", "selection": "#2a2e26" }

Hide
Type "clear"
Enter
Show

Type "# Your agent can write the CRM. It cannot approve the renewal."
Sleep 2.2s
Enter

Type "npm create -y accordo@latest acme-crm -- --apply"
Sleep 600ms
Enter
Sleep 14s

Type "cd acme-crm"
Enter
Sleep 800ms

Type "# An agent moves two renewals forward. Watch what the €80k one does."
Sleep 2s
Enter

Type `npm run --silent crm -- demo | jq -r '"OPPORTUNITIES:", (.opportunities[] | "  \(.name)  €\(.valueCents/100000)k  →  \(.stage)"), "", "APPROVALS:", (.approvals[] | "  \(.status)  \(.opportunityName)", "  reason: \(.reason)", "  requested by: \(.requestedBy)   decided by: \(.decidedBy // "nobody yet — a human decides that")")'`
Sleep 600ms
Enter
Sleep 9s

Type "# Not a prompt instruction. A workflow step, in code you own:"
Sleep 2s
Enter

Type `npm run --silent crm -- workflow:list | jq -r '.items[] | select(.name == "request-opportunity-stage-change") | .name, (.steps[] | "    · \(.)")'`
Sleep 600ms
Enter
Sleep 6s

Type "# Deterministic policy, human approval, audit and trace. As code."
Sleep 1s
Enter
Type "# https://accordo.dev · npm create accordo"
Sleep 5s
Enter
