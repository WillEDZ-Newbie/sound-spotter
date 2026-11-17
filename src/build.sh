#!/bin/sh
# Assembles ../index.html from head.html + core.js + ui.js, embedding ../model.json as the built-in model.
set -e
cd "$(dirname "$0")"
python3 - <<'PY'
import json
m=json.dumps(json.load(open('../model.json')),separators=(',',':'))
out=open('head.html').read()+open('core.js').read()+open('ui.js').read().replace('__MODEL__',m)+'</script>\n</body>\n</html>\n'
open('../index.html','w').write(out); print('built index.html',len(out),'bytes')
PY
