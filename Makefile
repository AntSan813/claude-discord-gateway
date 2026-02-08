PROJECTS_DIR ?= $(HOME)/assistants

.PHONY: start stop restart logs kill-claude add-project

start:
	@if [ -f .pid ]; then echo "Already running (PID $$(cat .pid)). Run 'make stop' first."; exit 1; fi
	@setsid npm run start > bot.logs 2>&1 & echo $$! > .pid
	@echo "Started (PID $$(cat .pid)). Logs: make logs"

stop:
	@if [ ! -f .pid ]; then echo "Not running."; exit 0; fi
	@kill -- -$$(cat .pid) 2>/dev/null || kill $$(cat .pid) 2>/dev/null; rm -f .pid
	@echo "Stopped."

restart: stop start

logs:
	@tail -f bot.logs

kill-claude:
	@pkill -f "claude.*--session-id" 2>/dev/null && echo "Killed Claude Code processes." || echo "No Claude Code processes running."

add-project:
	@if [ -z "$(CHANNEL_ID)" ]; then \
		echo "Error: CHANNEL_ID is required"; \
		echo "Usage: make add-project CHANNEL_ID=1234567890"; \
		exit 1; \
	fi
	@echo "Creating new project for channel $(CHANNEL_ID)..."
	@read -p "Project name: " name; \
	if [ -z "$$name" ]; then \
		echo "Error: Project name cannot be empty"; \
		exit 1; \
	fi; \
	if [ -d "$(PROJECTS_DIR)/$$name" ] || [ -L "$(PROJECTS_DIR)/$$name" ]; then \
		echo "Error: Project '$$name' already exists"; \
		exit 1; \
	fi; \
	read -p "Link to existing directory? (leave empty to create new): " link_path; \
	if [ -n "$$link_path" ]; then \
		if [ ! -d "$$link_path" ]; then \
			echo "Error: Directory does not exist: $$link_path"; \
			exit 1; \
		fi; \
		ln -s "$$(cd "$$link_path" && pwd)" "$(PROJECTS_DIR)/$$name"; \
		echo "Created symlink: $(PROJECTS_DIR)/$$name -> $$link_path"; \
	else \
		mkdir -p "$(PROJECTS_DIR)/$$name"; \
		echo "Created directory: $(PROJECTS_DIR)/$$name"; \
	fi; \
	target="$(PROJECTS_DIR)/$$name"; \
	cp -rn $(PROJECTS_DIR)/.template/. "$$target/"; \
	sed -i "s/{{PROJECT_NAME}}/$$name/g; s/{{CHANNEL_ID}}/$(CHANNEL_ID)/g" "$$target/discord.json" "$$target/CLAUDE.md"; \
	echo ""; \
	echo "Project '$$name' is ready! Scaffolded files:"; \
	ls -1a "$$target" | grep -v '^\.\.\?$$'; \
	echo ""; \
	echo "Restart the bot with: make restart"
