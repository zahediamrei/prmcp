#!/usr/bin/env bash
# dev-call.sh fnName '[args...]'
curl -s localhost:8098/call -d "{\"fn\":\"$1\",\"args\":${2:-[]}}" | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d.get('result',d) if 'error' not in d else {'ERROR':d['error']}, ensure_ascii=False))"
