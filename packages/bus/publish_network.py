"""Archive a validated static release in Worker KV, then expose it in the catalog."""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT/"packages/worker"
CATALOG = "schedule:/bus-data/catalog.json"


def publish(source, mode, persist):
    flags = ["--binding", "SNAPSHOT", mode]
    if persist:
        flags += ["--persist-to", str(persist.resolve())]

    def kv(*args):
        command = [str(WORKER/"node_modules/.bin/wrangler"), "kv", *args, *flags]
        return subprocess.check_output(command, cwd=WORKER)

    # CI serializes publications to this catalog. A failed batch cannot activate
    # a partial release; a retry can safely rewrite the same immutable bytes.
    keys = json.loads(kv("key","list","--prefix",CATALOG))
    catalog = json.loads(kv("key","get",CATALOG)) if any(k["name"]==CATALOG for k in keys) else []
    with tempfile.TemporaryDirectory() as tmp:
        batch_file = Path(tmp)/"batch.json"

        def store(batch):
            batch_file.write_text(json.dumps(batch,separators=(",",":")))
            kv("bulk","put",str(batch_file))

        for release in json.loads((source/"catalog.json").read_bytes()):
            if release in catalog:
                continue
            version = release["networkVersion"]
            directory = source/version
            manifest = json.loads((directory/"release.json").read_bytes())
            if any(manifest[k]!=v for k,v in release.items()):
                raise ValueError("Catalog disagrees with immutable release")
            batch, size = [], 0
            for path in sorted(directory.rglob("*.json")):
                value = path.read_text()
                json.loads(value)
                batch.append(dict(key="schedule:/bus-data/"+path.relative_to(source).as_posix(),value=value))
                size += path.stat().st_size
                if size >= 6*1024*1024:
                    store(batch)
                    batch, size = [], 0
            if batch:
                store(batch)
            catalog.append(release)
            print("Archived",version,flush=True)
        store([dict(key=CATALOG,value=json.dumps(catalog,separators=(",",":")))])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,default=ROOT/"packages/web/public/bus-data")
    parser.add_argument("--remote",action="store_true",help="Publish in the configured Cloudflare account")
    parser.add_argument("--persist-to",type=Path)
    args = parser.parse_args()
    publish(args.source,"--remote" if args.remote else "--local",args.persist_to)
