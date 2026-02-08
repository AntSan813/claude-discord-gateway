.PHONY: start stop restart logs kill-claude

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
