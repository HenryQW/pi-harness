# Use local Delivery Graphs

Pi Auto DAG uses ignored `.context/issues/graph.json` in main integration worktree as sole delivery authority instead of GitHub Issues. Run state pins normalized graph by SHA-256 while Git source commit pins tracked code/config; child worktrees receive only Local Issue slices. GitHub remains limited to pull requests, CI, review threads, and explicit health repair.
