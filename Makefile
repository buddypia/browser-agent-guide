.PHONY: wt.new wt.run q.check q.ci-mirror setup.skills setup.mcp mcp.setup

wt.new:
	@if [ -z "$(BR)" ]; then \
		echo "wt.new: BR=<branch> required. Example: make wt.new BR=feature/<task>"; \
		exit 2; \
	fi
	@node .claude/scripts/worktree-new.mjs --branch $(BR) $(if $(BASE),--base $(BASE)) $(if $(DRY),--dry-run)

wt.run:
	@if [ -z "$(CMD)" ]; then \
		echo "wt.run: CMD=\"<command>\" required. Example: make wt.run CMD=\"npm run check\""; \
		exit 2; \
	fi
	@node .claude/scripts/wt-run.mjs $(CMD)

q.check:
	npm run check
	cd daemon && npm test

q.ci-mirror: q.check
	@mkdir -p .tmp
	@touch .tmp/ci-mirror-passed

setup.skills:
	@node .claude/scripts/setup-skills.mjs

setup.mcp:
	@node .claude/scripts/setup-mcp.mjs

mcp.setup: setup.mcp
