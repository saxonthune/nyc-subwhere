"""Build the six MTA archives into immutable Worker assets (Python standard library)."""
import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import itertools
import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

FEEDS = ("b", "bx", "m", "q", "si", "busco")
WEEK = "monday tuesday wednesday thursday friday saturday sunday".split()
ROOT = Path(__file__).resolve().parents[2]


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as out:
        json.dump(value, out, separators=(",", ":"), allow_nan=False, ensure_ascii=False)


def rows(archive, name):
    with archive.open(name + ".txt") as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as text:
        yield from csv.DictReader(text)


def digest(path):
    with path.open("rb") as f:
        result = hashlib.sha256()
        for chunk in iter(lambda: f.read(1048576), b""):
            result.update(chunk)
        return result.hexdigest()


def download(folder):
    folder.mkdir(parents=True, exist_ok=True)
    for feed in FEEDS:
        with tempfile.NamedTemporaryFile(dir=folder) as tmp:
            url = f"https://rrgtfsfeeds.s3.amazonaws.com/gtfs_{feed}.zip"
            with urllib.request.urlopen(url, timeout=90) as src:
                shutil.copyfileobj(src, tmp)
            tmp.flush()
            with zipfile.ZipFile(tmp.name) as z:
                if z.testzip():
                    raise ValueError(f"Invalid download for {feed}")
            shutil.copyfile(tmp.name, folder / (feed + ".zip"))


def seconds(text):
    h, m, s = map(int, text.split(":"))
    if h < 0 or not 0 <= m < 60 or not 0 <= s < 60:
        raise ValueError(f"Invalid GTFS time {text}")
    return 3600*h + 60*m + s


def bucket(stop_id):
    value = 0
    for char in stop_id:
        value = (value*31+ord(char)) & 0xffffffff
    return value % 64


def dates(start, end):
    day = dt.datetime.strptime(start, "%Y%m%d").date()
    while day.strftime("%Y%m%d") <= end:
        yield day
        day += dt.timedelta(days=1)


def calendar(archive, feed, days):
    active = {}
    for r in rows(archive, "calendar"):
        active[r["service_id"]] = {d.strftime("%Y%m%d") for d in dates(r["start_date"], r["end_date"]) if r[WEEK[d.weekday()]] == "1"}
    for r in rows(archive, "calendar_dates"):
        valid = active.setdefault(r["service_id"], set())
        if r["exception_type"] == "1":
            valid.add(r["date"])
        elif r["exception_type"] == "2":
            valid.discard(r["date"])
        else:
            raise ValueError("Invalid service exception")
    for service, valid in active.items():
        for day in valid:
            days[day].append(feed+":"+service)
    return active


def add_stops(archive, feed, stops, curbs_by_raw):
    aliases = {}
    for row in rows(archive, "stops"):
        raw = row["stop_id"]
        lon, lat = float(row["stop_lon"]), float(row["stop_lat"])
        # MTA's numeric pole ID is shared across operators. Confirm the location
        # before merging. Conflicting positions retain independent curb identities.
        candidates = curbs_by_raw[raw]
        nearby = [key for key in candidates if math.hypot(
            (lon-stops[key]["lon"])*84000, (lat-stops[key]["lat"])*111000
        ) <= 25]
        if len(nearby) == 1:
            key = nearby[0]
        else:
            key = feed+":"+raw if candidates else raw
            candidates.append(key)
        pos = stops.setdefault(key, dict(stopId=key, name=row["stop_name"], lon=lon, lat=lat, sources=[]))
        pos["sources"].append([feed, raw])
        aliases[raw] = key
    return aliases


def intern(value, index, values):
    if value not in index:
        index[value] = len(values)
        values.append(value)
    return index[value]


def build_feed(archive, feed, folder, days, stops, by_stop, curbs_by_raw):
    valid = calendar(archive, feed, days)
    aliases = add_stops(archive, feed, stops, curbs_by_raw)
    routes = {r["route_id"]: r for r in rows(archive, "routes")}
    trips = {r["trip_id"]: r for r in rows(archive, "trips")}
    total_trips = len(trips)
    tables = {}
    pattern_index, offset_index = collections.defaultdict(dict), collections.defaultdict(dict)
    matches = collections.defaultdict(dict)
    shape_routes = collections.defaultdict(set)
    max_seconds = 0
    count = 0
    for trip_id, group in itertools.groupby(rows(archive, "stop_times"), key=lambda r:r["trip_id"]):
        trip = trips.pop(trip_id)
        route = trip["route_id"]
        service = trip["service_id"]
        if service not in valid:
            raise ValueError(f"Unknown service {service}")
        table = tables.setdefault(route, dict(feed=feed,routeId=route,routeName=routes[route]["route_short_name"],patterns=[],offsets=[],trips=[]))
        file = feed+"-"+route
        calls = sorted(group, key=lambda r:int(r["stop_sequence"]))
        visits, times = [], []
        for call in calls:
            arrival, departure = seconds(call["arrival_time"]), seconds(call["departure_time"])
            seq = int(call["stop_sequence"])
            if visits and seq <= visits[-1][1] or arrival > departure or times and arrival < times[-1]:
                raise ValueError(f"Invalid stop ordering on {trip_id} at {seq}")
            stop_id = aliases[call["stop_id"]]
            visits.append((stop_id, seq, int(call["pickup_type"] or 0), int(call["drop_off_type"] or 0)))
            times.extend([arrival, departure])
            by_stop[stop_id].add(file)
        pattern = intern(tuple(visits), pattern_index[route], table["patterns"])
        offsets = intern(tuple(t-times[0] for t in times), offset_index[route], table["offsets"])
        table["trips"].append([trip_id, feed+":"+service, trip["trip_headsign"], pattern, offsets, times[0]])
        matches[service][trip_id] = [route,times[-1]]
        shape_routes[trip["shape_id"]].add(route)
        max_seconds = max(max_seconds, times[-1])
        count += len(visits)
    if trips:
        raise ValueError(f"{len(trips)} trips without stops")
    for route, table in tables.items():
        dump(folder/"routes"/(feed+"-"+route+".json"),table)
    for service in valid:
        dump(folder/"services"/(feed+":"+service+".json"),matches[service])
    shapes = collections.defaultdict(list)
    for r in rows(archive,"shapes"):
        if r["shape_id"] in shape_routes:
            shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]),float(r["shape_pt_lon"]),float(r["shape_pt_lat"])))
    features = []
    for shape, routes_using in shape_routes.items():
        points = [[lon,lat] for _,lon,lat in sorted(shapes[shape])]
        if len(points)<2:
            raise ValueError(f"Missing geometry for {shape}")
        features.append(dict(type="Feature",properties=dict(feed=feed,shapeId=shape,routeIds=sorted(routes_using)),geometry=dict(type="LineString",coordinates=points)))
    dump(folder/("shapes-"+feed+".json"),dict(type="FeatureCollection",features=features))
    print(f"{feed}: {total_trips} trips, {count} calls, {len(tables)} routes", flush=True)
    return max_seconds


def build(source, output):
    import fcntl
    hashes = {feed:digest(source/(feed+".zip")) for feed in FEEDS}
    version = hashlib.sha256((digest(Path(__file__))+json.dumps(hashes)).encode()).hexdigest()[:20]
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        stage = Path(temporary)/version
        days, by_stop, stops = collections.defaultdict(list), collections.defaultdict(set), {}
        curbs_by_raw = collections.defaultdict(list)
        start, end, longest = "", "99999999", 0
        for feed in FEEDS:
            with zipfile.ZipFile(source/(feed+".zip")) as archive:
                info = next(rows(archive,"feed_info"))
                start, end = max(start,info["feed_start_date"]), min(end,info["feed_end_date"])
                longest = max(longest,build_feed(archive,feed,stage,days,stops,by_stop,curbs_by_raw))
        if start>end:
            raise ValueError("No common service coverage across all six feeds")
        base = "/bus-data/"+version
        network = dict(schemaVersion=1,networkVersion=version,startDate=start,endDate=end,stopsUrl=base+"/curbs.json",shapesUrls=[base+"/shapes-"+f+".json" for f in FEEDS])
        dump(stage/"curbs.json",[s for key,s in stops.items() if key in by_stop])
        for index in range(64):
            dump(stage/f"stops-{index}.json",{k:sorted(v) for k,v in by_stop.items() if bucket(k)==index})
        dump(stage/"release.json",dict(**network,days={k:sorted(v) for k,v in days.items()},maxSeconds=longest,archives=hashes))
        for path in stage.rglob("*.json"):
            if path.stat().st_size >= 25*1024*1024:
                raise ValueError(f"Oversized Worker asset {path.name}")
            json.loads(path.read_bytes())
        # Serialize publishers; expose the catalog only after every asset exists.
        lock_path = output.parent/".bus-publish.lock"
        with lock_path.open("a") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            if not (output/version).exists():
                os.rename(stage,output/version)
            catalog = output/"catalog.json"
            releases = json.loads(catalog.read_bytes()) if catalog.exists() else []
            if network not in releases:
                releases.append(network)
            tmp = Path(temporary)/"catalog.json"
            dump(tmp,releases)
            os.replace(tmp,catalog)
        print(f"Published {version}, {start} through {end}, {len(by_stop)} curbs",flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path, default=ROOT/"data/bus")
    parser.add_argument("--output",type=Path, default=ROOT/"packages/web/public/bus-data")
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args()
    if args.fetch:
        download(args.source)
    build(args.source,args.output)
