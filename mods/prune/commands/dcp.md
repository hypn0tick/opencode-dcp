---
description: Show whether DCP (Dynamic Context Pruning) is active in this session
---

Tell the user, in one or two lines, whether Dynamic Context Pruning is active in this session. It is active when your `prune` tool is DCP's pruning tool; it is not active when that tool's description begins with "Unavailable" (Claude Code's status line then says why). When active, mention they can prune on demand with the DCP prune command. When not active, tell them the usual fix is to restart Claude Code once after installing, and to check the status line for anything else. Do not call any tool.
