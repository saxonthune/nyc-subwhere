import contextlib
import csv
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_network import FEEDS, build, bucket


def fixture_archive(path, feed, start, end):
    with zipfile.ZipFile(path, "w") as archive:
        def table(name, text):
            archive.writestr(name+".txt",text.strip()+"\n")
        table("feed_info",f"feed_start_date,feed_end_date\n{start},{end}")
        table("calendar",f"service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,{start},{end}")
        table("calendar_dates",f"service_id,date,exception_type\ns,{end},2")
        lon = "-73.8" if feed=="q" else "-73.96"
        table("stops",f"stop_id,stop_name,stop_lat,stop_lon\n17,Shared curb,40.7,{lon}\n18,Downstream,40.71,{lon}")
        table("routes","route_id,route_short_name\nR,R")
        table("trips","trip_id,route_id,service_id,trip_headsign,shape_id\nt,R,s,Downstream,line")
        table("shapes","shape_id,shape_pt_sequence,shape_pt_lat,shape_pt_lon\nline,2,40.71,-73.96\nline,1,40.7,-73.96")
        table("stop_times","trip_id,stop_sequence,stop_id,arrival_time,departure_time,pickup_type,drop_off_type\nt,1,17,24:59:00,25:00:00,0,1\nt,3,18,25:05:00,25:05:00,1,0\nt,5,17,25:10:00,25:10:00,1,0")


class Publication(unittest.TestCase):
    def test_two_quarters_collision_exceptions_and_invalid_refresh(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            source, output = Path(tmp)/"inputs",Path(tmp)/"output"
            source.mkdir()
            for start,end in [("20260901","20260930"),("20261001","20261231")]:
                for feed in FEEDS:
                    fixture_archive(source/(feed+".zip"),feed,start,end)
                build(source,output)
            catalog = json.loads((output/"catalog.json").read_bytes())
            self.assertEqual(len(catalog),2)
            old,new = catalog
            self.assertLess(old["endDate"],new["startDate"])
            for network in catalog:
                folder=output/network["networkVersion"]
                release=json.loads((folder/"release.json").read_bytes())
                self.assertEqual(release["maxSeconds"],90600)
                self.assertEqual(set(release["days"][network["startDate"]]),{feed+":s" for feed in FEEDS})
                self.assertFalse(release["days"].get(network["endDate"]))
                shared=json.loads((folder/f"stops-{bucket('17')}.json").read_bytes())["17"]
                self.assertEqual(len(shared),5)
                curbs=json.loads((folder/"curbs.json").read_bytes())
                self.assertEqual(next(c["sources"] for c in curbs if c["stopId"]=="q:17"),[["q","17"]])
                line=json.loads((folder/"routes/q-R.json").read_bytes())
                self.assertEqual(line["patterns"][0],[["q:17",1,0,1],["q:18",3,1,0],["q:17",5,1,0]])
            before=(output/"catalog.json").read_bytes()
            (source/"m.zip").write_bytes(b"interrupted")
            with self.assertRaises(zipfile.BadZipFile):
                build(source,output)
            self.assertEqual(before,(output/"catalog.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
