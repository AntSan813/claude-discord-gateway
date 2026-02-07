run:
	pkill -f "tsx src/index" 2>/dev/null \
	| tsx src/index.ts
